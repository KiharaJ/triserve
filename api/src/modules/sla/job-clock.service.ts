import { Injectable } from '@nestjs/common';
import { Prisma, type HoldKind, type WorkflowStage } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Job clocks & SLA metrics (SCMS proposal Module 2, "Time Tracking (KPI
 * Metrics)").
 *
 * The proposal asks for three operational measures plus a pause-aware SLA:
 *
 *   CTD — Clock-to-Diagnosis: intake → the moment a technician actually
 *         started diagnosing. Measures the FRONT of the shop (routing,
 *         assignment, bench backlog), not the repair itself.
 *   HFP — Hold-for-Parts Duration: total time parked waiting for stock.
 *         Separated out because it is the one delay the bench cannot fix and
 *         the one procurement is accountable for.
 *   TAT — Total Turnaround Time: intake → handover. The number the customer
 *         experiences.
 *
 *   "Any pause state (e.g. waiting for customer approval) halts customer SLA
 *    countdowns but runs an internal secondary tracking clock."
 *
 * All four are derived from `job_state_events` — one append-only row per
 * OCCUPANCY of a state — rather than from `jobs` columns, because a job can
 * enter the same state repeatedly (QC bounces it back to the bench; parts run
 * out twice) and only a log can add those up. The row snapshots
 * `stage`/`hold_kind`/`pauses_sla` at entry, so reclassifying the workflow
 * tomorrow never rewrites yesterday's numbers.
 *
 * INVARIANT, enforced by {@link recordEntry}: a job has at most ONE open row
 * (`exited_at IS NULL`) at any time, and it always describes `jobs.state_id`.
 * Every writer must pass its transaction client so the log and the state
 * change commit together.
 */

/** The Prisma client or an interactive-transaction handle. */
type Db = PrismaService | Prisma.TransactionClient;

/** One state occupancy, as the reports read it. */
interface Occupancy {
  stage: WorkflowStage;
  holdKind: HoldKind;
  pausesSla: boolean;
  enteredAt: Date;
  exitedAt: Date | null;
  durationMs: bigint | null;
}

/** Everything the proposal's KPI panel shows for one job. */
export interface JobClockMetrics {
  job_id: string;
  /** Intake timestamp — the origin of every clock. */
  received_at: string;
  /** Clock-to-Diagnosis in ms; null until diagnosis starts. */
  ctd_ms: number | null;
  /** Total Hold-for-Parts in ms across every parts hold (0 if never held). */
  hfp_ms: number;
  /** Total time paused for the customer (approval waits) in ms. */
  customer_hold_ms: number;
  /** Turnaround so far, or final turnaround once handed over. */
  tat_ms: number;
  /** True once the job reached a terminal state — `tat_ms` is then final. */
  tat_final: boolean;
  /**
   * Elapsed time that COUNTS against the customer-facing SLA: wall clock minus
   * every paused occupancy. This is what the SLA bands are computed from.
   */
  sla_elapsed_ms: number;
  /** The internal clock — plain wall time, pauses included. */
  internal_elapsed_ms: number;
  /** The job's SLA target, when one was set. */
  sla_due_at: string | null;
  /** Budget remaining as a percentage of the total SLA window; null if no SLA. */
  sla_remaining_percent: number | null;
  /** Colour band per the proposal's queue rule. */
  sla_band: SlaBand;
  /** How many times QC rejected the unit — the first-time-fix signal. */
  qc_reject_count: number;
  /** Per-stage totals, for the bench breakdown. */
  stage_totals_ms: Record<string, number>;
}

/**
 * The proposal's colour rule: "Green: >50% SLA remaining; Amber: 20-50%;
 * Red: <20% or breached." `NONE` is the honest fourth case the proposal
 * doesn't name — a job with no SLA target set has no band, and colouring it
 * green would claim a guarantee nobody made.
 */
export type SlaBand = 'GREEN' | 'AMBER' | 'RED' | 'NONE';

/** Bands from remaining budget. Boundaries follow the proposal literally. */
export function slaBandFor(remainingPercent: number | null): SlaBand {
  if (remainingPercent === null) return 'NONE';
  if (remainingPercent < 20) return 'RED';
  if (remainingPercent <= 50) return 'AMBER';
  return 'GREEN';
}

@Injectable()
export class JobClockService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Close the job's currently-open occupancy and open one for `toStateId`.
   *
   * MUST be called inside the same transaction as the `jobs.state_id` update
   * — the log is only trustworthy if it cannot drift from the job row.
   *
   * Returns the derived stamps the caller should merge onto the job:
   * `diagnosisStartedAt` / `repairStartedAt` are first-entry timestamps, and
   * deriving them here keeps the "what does entering this stage mean" rule in
   * one place instead of scattered through JobsService.
   */
  async recordEntry(
    db: Db,
    params: {
      companyId: string;
      branchId: string;
      jobId: string;
      toStateId: string;
      fromStateId: string | null;
      actorUserId: string | null;
      engineerId: string | null;
      note?: string | null;
      at?: Date;
    },
  ): Promise<{ diagnosisStartedAt?: Date; repairStartedAt?: Date }> {
    const at = params.at ?? new Date();

    const state = await db.workflowState.findFirst({
      where: { id: params.toStateId },
      select: { stage: true, holdKind: true, pausesSla: true },
    });
    // A state that vanished mid-transition cannot happen (the FK holds), but
    // the log must never be the thing that fails a legitimate move: fall back
    // to the neutral classification rather than throwing.
    const stage: WorkflowStage = state?.stage ?? 'INTAKE';
    const holdKind: HoldKind = state?.holdKind ?? 'NONE';
    const pausesSla = state?.pausesSla ?? false;

    // Close the open row. `updateMany` (not `update`) on purpose: there may be
    // no open row at all — a job created before this feature landed, or the
    // very first entry — and that is not an error.
    const open = await db.jobStateEvent.findFirst({
      where: { jobId: params.jobId, exitedAt: null },
      orderBy: { enteredAt: 'desc' },
      select: { id: true, enteredAt: true },
    });
    if (open) {
      // Clamp at zero: two moves inside the same millisecond, or a clock that
      // stepped backwards, must not produce a negative duration that then
      // silently subtracts from a SUM.
      const ms = Math.max(0, at.getTime() - open.enteredAt.getTime());
      await db.jobStateEvent.update({
        where: { id: open.id },
        data: { exitedAt: at, durationMs: BigInt(ms) },
      });
    }

    await db.jobStateEvent.create({
      data: {
        id: randomUUID(),
        companyId: params.companyId,
        branchId: params.branchId,
        jobId: params.jobId,
        stateId: params.toStateId,
        fromStateId: params.fromStateId,
        stage,
        holdKind,
        pausesSla,
        enteredAt: at,
        actorUserId: params.actorUserId,
        engineerId: params.engineerId,
        note: params.note ?? null,
      },
    });

    const stamps: { diagnosisStartedAt?: Date; repairStartedAt?: Date } = {};
    if (stage === 'DIAGNOSIS') stamps.diagnosisStartedAt = at;
    if (stage === 'REPAIR') stamps.repairStartedAt = at;
    return stamps;
  }

  /** Compute the full KPI panel for one job. */
  async metricsFor(jobId: string): Promise<JobClockMetrics | null> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
      select: {
        id: true,
        receivedAt: true,
        dispatchedAt: true,
        slaDueAt: true,
        diagnosisStartedAt: true,
        qcRejectCount: true,
        state: { select: { isTerminal: true } },
      },
    });
    if (!job) return null;

    const events = await this.prisma.jobStateEvent.findMany({
      where: { jobId },
      orderBy: { enteredAt: 'asc' },
      select: {
        stage: true,
        holdKind: true,
        pausesSla: true,
        enteredAt: true,
        exitedAt: true,
        durationMs: true,
      },
    });

    return this.derive(
      {
        id: job.id,
        receivedAt: job.receivedAt,
        dispatchedAt: job.dispatchedAt,
        slaDueAt: job.slaDueAt,
        diagnosisStartedAt: job.diagnosisStartedAt,
        qcRejectCount: job.qcRejectCount,
        terminal: job.state.isTerminal,
      },
      events,
    );
  }

  /**
   * Same computation for a job whose row and events the caller ALREADY has —
   * used by the job list/board so N jobs cost two queries, not 2N.
   */
  derive(
    job: {
      id: string;
      receivedAt: Date;
      dispatchedAt: Date | null;
      slaDueAt: Date | null;
      diagnosisStartedAt: Date | null;
      qcRejectCount: number;
      terminal: boolean;
    },
    events: Occupancy[],
    now: Date = new Date(),
  ): JobClockMetrics {
    // The clock stops at handover for a finished job, and keeps running for a
    // live one. Using `now` for a job dispatched last month would report an
    // ever-growing turnaround for work that is long done.
    const end = job.dispatchedAt ?? (job.terminal ? lastExit(events) ?? now : now);

    let hfpMs = 0;
    let customerHoldMs = 0;
    let pausedMs = 0;
    const stageTotals: Record<string, number> = {};

    for (const e of events) {
      const ms = occupancyMs(e, now);
      stageTotals[e.stage] = (stageTotals[e.stage] ?? 0) + ms;
      if (e.pausesSla) pausedMs += ms;
      if (e.stage === 'HOLD') {
        if (e.holdKind === 'PARTS') hfpMs += ms;
        else if (e.holdKind === 'CUSTOMER') customerHoldMs += ms;
      }
    }

    const internalElapsedMs = Math.max(0, end.getTime() - job.receivedAt.getTime());
    // The customer's clock: wall time minus every pause. Floored at zero
    // because paused time is measured against `now` while `end` may be
    // earlier for a finished job.
    const slaElapsedMs = Math.max(0, internalElapsedMs - pausedMs);

    const ctdMs = job.diagnosisStartedAt
      ? Math.max(0, job.diagnosisStartedAt.getTime() - job.receivedAt.getTime())
      : null;

    // Remaining budget is measured on the PAUSE-ADJUSTED clock, which is the
    // whole point of the pause rule: a job parked three days on a customer
    // decision must not come back red through no fault of the bench.
    let remainingPercent: number | null = null;
    if (job.slaDueAt) {
      const windowMs = job.slaDueAt.getTime() - job.receivedAt.getTime();
      remainingPercent =
        windowMs <= 0
          ? 0 // A due date at or before intake is already breached.
          : Math.max(
              0,
              Math.min(100, ((windowMs - slaElapsedMs) / windowMs) * 100),
            );
    }

    return {
      job_id: job.id,
      received_at: job.receivedAt.toISOString(),
      ctd_ms: ctdMs,
      hfp_ms: hfpMs,
      customer_hold_ms: customerHoldMs,
      tat_ms: internalElapsedMs,
      tat_final: job.terminal || job.dispatchedAt !== null,
      sla_elapsed_ms: slaElapsedMs,
      internal_elapsed_ms: internalElapsedMs,
      sla_due_at: job.slaDueAt?.toISOString() ?? null,
      sla_remaining_percent:
        remainingPercent === null ? null : Math.round(remainingPercent * 10) / 10,
      // A terminal job is never coloured — it is not in anyone's queue.
      sla_band: job.terminal ? 'NONE' : slaBandFor(remainingPercent),
      qc_reject_count: job.qcRejectCount,
      stage_totals_ms: stageTotals,
    };
  }

  /**
   * Bulk metrics for a set of jobs — two queries total, for the board/list.
   * Jobs with no event rows still get an entry (all-zero clocks), so callers
   * can index the map without null checks.
   */
  async metricsForMany(jobIds: string[]): Promise<Map<string, JobClockMetrics>> {
    const out = new Map<string, JobClockMetrics>();
    if (jobIds.length === 0) return out;

    const [jobs, events] = await Promise.all([
      this.prisma.job.findMany({
        where: { id: { in: jobIds }, deletedAt: null },
        select: {
          id: true,
          receivedAt: true,
          dispatchedAt: true,
          slaDueAt: true,
          diagnosisStartedAt: true,
          qcRejectCount: true,
          state: { select: { isTerminal: true } },
        },
      }),
      this.prisma.jobStateEvent.findMany({
        where: { jobId: { in: jobIds } },
        orderBy: { enteredAt: 'asc' },
        select: {
          jobId: true,
          stage: true,
          holdKind: true,
          pausesSla: true,
          enteredAt: true,
          exitedAt: true,
          durationMs: true,
        },
      }),
    ]);

    const byJob = new Map<string, Occupancy[]>();
    for (const e of events) {
      const list = byJob.get(e.jobId);
      if (list) list.push(e);
      else byJob.set(e.jobId, [e]);
    }

    const now = new Date();
    for (const j of jobs) {
      out.set(
        j.id,
        this.derive(
          {
            id: j.id,
            receivedAt: j.receivedAt,
            dispatchedAt: j.dispatchedAt,
            slaDueAt: j.slaDueAt,
            diagnosisStartedAt: j.diagnosisStartedAt,
            qcRejectCount: j.qcRejectCount,
            terminal: j.state.isTerminal,
          },
          byJob.get(j.id) ?? [],
          now,
        ),
      );
    }
    return out;
  }
}

/**
 * How long an occupancy lasted. A CLOSED row uses its stored duration (the
 * authoritative number, written when it closed); an OPEN row is measured
 * against `now` — it is still accruing.
 */
function occupancyMs(e: Occupancy, now: Date): number {
  if (e.durationMs !== null) return Number(e.durationMs);
  const end = e.exitedAt ?? now;
  return Math.max(0, end.getTime() - e.enteredAt.getTime());
}

/** The latest exit across all occupancies — when a terminal job actually stopped. */
function lastExit(events: Occupancy[]): Date | null {
  let latest: Date | null = null;
  for (const e of events) {
    if (e.exitedAt && (!latest || e.exitedAt > latest)) latest = e.exitedAt;
  }
  return latest;
}
