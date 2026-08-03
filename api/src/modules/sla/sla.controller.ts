import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Prisma, type WorkflowStage } from '@prisma/client';
import { IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  JobClockService,
  slaBandFor,
  type JobClockMetrics,
  type SlaBand,
} from './job-clock.service';

export class SlaReportQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  engineer_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** One technician's or branch's aggregate KPI row. */
export interface SlaAggregateWire {
  key: string;
  label: string;
  jobs: number;
  /** Median is reported alongside the mean: one four-week job drags a mean. */
  avg_ctd_ms: number | null;
  median_ctd_ms: number | null;
  avg_hfp_ms: number;
  avg_tat_ms: number | null;
  median_tat_ms: number | null;
  /** Finished within the SLA target, of those that HAD one. */
  on_time: number;
  breached: number;
  on_time_percent: number | null;
  /** Jobs QC bounced at least once — the inverse of first-time-fix. */
  rework_jobs: number;
  first_time_fix_percent: number | null;
}

/** The live queue, colour-banded per the proposal's rule. */
export interface SlaQueueWire {
  counts: Record<SlaBand, number>;
  jobs: Array<{
    job_id: string;
    job_no: string;
    state_code: string;
    stage: WorkflowStage;
    engineer_id: string | null;
    engineer_name: string | null;
    sla_band: SlaBand;
    sla_remaining_percent: number | null;
    sla_due_at: string | null;
    hfp_ms: number;
    tat_ms: number;
  }>;
}

/**
 * /api/v1 — SLA & KPI reporting (SCMS proposal Module 2, §3
 * "Dynamic SLA Queues" and "Time Tracking (KPI Metrics)").
 *
 *   GET /jobs/{id}/metrics    'job.read'            CTD / HFP / TAT for a job
 *   GET /sla/queue            'job.read'            the colour-banded queue
 *   GET /reports/sla          'report.view.branch'  aggregates by engineer
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class SlaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: JobClockService,
  ) {}

  @Get('jobs/:id/metrics')
  @RequirePermissions('job.read')
  async jobMetrics(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<JobClockMetrics> {
    const metrics = await this.clock.metricsFor(id);
    if (!metrics) throw new NotFoundException('Job not found');
    return metrics;
  }

  /**
   * The proposal's "Dynamic SLA Queues": "Techs operate via a centralized,
   * real-time workspace queue. Jobs are sorted dynamically via a color-coded
   * 'SLA Remaining Time' algorithm (Green: >50% SLA remaining; Amber: 20-50%;
   * Red: <20% or breached)."
   *
   * Ordered worst-first, which is the whole point: the queue exists to make
   * the next thing to work on obvious.
   */
  @Get('sla/queue')
  @RequirePermissions('job.read')
  async queue(
    @Query() query: SlaReportQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SlaQueueWire> {
    const where: Prisma.JobWhereInput = {
      deletedAt: null,
      state: { isTerminal: false },
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      // A technician's queue is their OWN work — the same rule JobsService
      // applies, restated here because this endpoint bypasses that service.
      ...(user.role === 'TECHNICIAN'
        ? { assignedEngineerId: user.userId }
        : query.engineer_id
          ? { assignedEngineerId: query.engineer_id }
          : {}),
    };

    const jobs = await this.prisma.job.findMany({
      where,
      select: {
        id: true,
        jobNo: true,
        assignedEngineerId: true,
        assignedEngineer: { select: { fullName: true } },
        state: { select: { code: true, stage: true } },
      },
      // Bounded: a queue view is for working from, not for exporting. The
      // aggregate report is the right tool for "every open job".
      take: 500,
    });

    const metrics = await this.clock.metricsForMany(jobs.map((j) => j.id));
    const counts: Record<SlaBand, number> = {
      RED: 0,
      AMBER: 0,
      GREEN: 0,
      NONE: 0,
    };

    const rows = jobs.map((j) => {
      const m = metrics.get(j.id);
      const band = m?.sla_band ?? 'NONE';
      counts[band]++;
      return {
        job_id: j.id,
        job_no: j.jobNo,
        state_code: j.state.code,
        stage: j.state.stage,
        engineer_id: j.assignedEngineerId,
        engineer_name: j.assignedEngineer?.fullName ?? null,
        sla_band: band,
        sla_remaining_percent: m?.sla_remaining_percent ?? null,
        sla_due_at: m?.sla_due_at ?? null,
        hfp_ms: m?.hfp_ms ?? 0,
        tat_ms: m?.tat_ms ?? 0,
      };
    });

    const BAND_ORDER: Record<SlaBand, number> = {
      RED: 0,
      AMBER: 1,
      GREEN: 2,
      NONE: 3,
    };
    rows.sort(
      (a, b) =>
        BAND_ORDER[a.sla_band] - BAND_ORDER[b.sla_band] ||
        (a.sla_remaining_percent ?? 999) - (b.sla_remaining_percent ?? 999),
    );

    return { counts, jobs: rows };
  }

  /**
   * GET /reports/sla — CTD / HFP / TAT and first-time-fix, per technician.
   *
   * Reports MEDIAN alongside mean throughout: a single job that sat three
   * weeks waiting for a part will drag a technician's mean turnaround into
   * uselessness, and performance conversations run on that number.
   */
  @Get('reports/sla')
  @RequirePermissions('report.view.branch')
  async report(
    @Query() query: SlaReportQueryDto,
  ): Promise<SlaAggregateWire[]> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    const jobs = await this.prisma.job.findMany({
      where: {
        deletedAt: null,
        ...(query.branch_id ? { branchId: query.branch_id } : {}),
        ...(query.engineer_id
          ? { assignedEngineerId: query.engineer_id }
          : {}),
        ...(from || to
          ? {
              receivedAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        assignedEngineerId: true,
        assignedEngineer: { select: { fullName: true } },
        slaDueAt: true,
        dispatchedAt: true,
      },
      take: 5000,
    });
    if (jobs.length === 0) return [];

    const metrics = await this.clock.metricsForMany(jobs.map((j) => j.id));

    const groups = new Map<
      string,
      { label: string; metrics: JobClockMetrics[]; onTime: number; breached: number }
    >();

    for (const j of jobs) {
      const key = j.assignedEngineerId ?? 'UNASSIGNED';
      const label = j.assignedEngineer?.fullName ?? 'Unassigned';
      const m = metrics.get(j.id);
      if (!m) continue;

      const g = groups.get(key) ?? {
        label,
        metrics: [],
        onTime: 0,
        breached: 0,
      };
      g.metrics.push(m);
      // On-time is only meaningful for jobs that HAD a target and have
      // FINISHED — counting an in-flight job as on-time flatters the number.
      if (j.slaDueAt && j.dispatchedAt) {
        if (j.dispatchedAt <= j.slaDueAt) g.onTime++;
        else g.breached++;
      }
      groups.set(key, g);
    }

    return [...groups.entries()]
      .map(([key, g]) => {
        const ctd = g.metrics
          .map((m) => m.ctd_ms)
          .filter((v): v is number => v !== null);
        const tat = g.metrics.filter((m) => m.tat_final).map((m) => m.tat_ms);
        const rework = g.metrics.filter((m) => m.qc_reject_count > 0).length;
        const rated = g.onTime + g.breached;

        return {
          key,
          label: g.label,
          jobs: g.metrics.length,
          avg_ctd_ms: mean(ctd),
          median_ctd_ms: median(ctd),
          avg_hfp_ms: Math.round(
            g.metrics.reduce((s, m) => s + m.hfp_ms, 0) / g.metrics.length,
          ),
          avg_tat_ms: mean(tat),
          median_tat_ms: median(tat),
          on_time: g.onTime,
          breached: g.breached,
          on_time_percent:
            rated === 0 ? null : Math.round((g.onTime / rated) * 1000) / 10,
          rework_jobs: rework,
          first_time_fix_percent:
            g.metrics.length === 0
              ? null
              : Math.round(
                  ((g.metrics.length - rework) / g.metrics.length) * 1000,
                ) / 10,
        };
      })
      .sort((a, b) => b.jobs - a.jobs);
  }
}

/** Arithmetic mean, or null for an empty set (never 0 — they differ). */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((s, v) => s + v, 0) / values.length);
}

/** Median — the robust centre, unmoved by one pathological job. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** Re-exported so callers importing the controller get the band helper too. */
export { slaBandFor };
