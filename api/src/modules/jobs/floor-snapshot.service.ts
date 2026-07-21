import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * The centre RIGHT NOW (§4.3 / E15) — the question a manager or owner asks
 * when they walk in: what needs attention today, where is work piling up, and
 * who is carrying it.
 *
 * Deliberately separate from the operations report, which answers a different
 * question: that one is historical BI over a date range (intake trend,
 * turnaround, model mix). This is a point-in-time snapshot with no range at
 * all — every figure is "as of now", and nothing here is stored, because
 * "overdue" is a function of the clock and any stored copy is stale the moment
 * it is written.
 *
 * OPEN means the job's workflow state is not terminal. A job that finished
 * late is history, not something to chase — so it appears in no count here.
 */

export interface FloorSnapshotWire {
  /** When this snapshot was taken. */
  at: string;
  /** The numbers worth acting on before anything else. */
  attention: {
    open: number;
    /** Past the internal SLA target and still open. */
    overdue: number;
    /** Target falls today (and not already past). */
    due_today: number;
    /** Open, HIGH or URGENT. */
    urgent: number;
    /** Open with nobody assigned — the most common reason work stalls. */
    unassigned: number;
    /** Open and taken in more than 14 days ago, whatever the target. */
    stale: number;
  };
  /** Open jobs by age since intake. */
  aging: { bucket: string; count: number }[];
  /** Where open work is sitting, and how much of it is late. */
  by_state: {
    code: string;
    label: string;
    sort_order: number;
    count: number;
    overdue: number;
  }[];
  /** Load per service line; `null` id is work with no line set. */
  by_line: {
    service_category_id: string | null;
    label: string;
    count: number;
    overdue: number;
  }[];
  priority_mix: { priority: string; count: number }[];
  /** Who is carrying what. `null` id is the unassigned pile. */
  engineers: {
    engineer_id: string | null;
    name: string;
    initials: string | null;
    active: number;
    overdue: number;
    /** Age of their oldest open job, in whole days. */
    oldest_days: number | null;
  }[];
}

/** Age buckets, in days since intake. `max: null` is the open-ended tail. */
const AGE_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: '0–2 days', min: 0, max: 2 },
  { label: '3–7 days', min: 3, max: 7 },
  { label: '8–14 days', min: 8, max: 14 },
  { label: '15+ days', min: 15, max: null },
];

const STALE_DAYS = 14;
const DAY_MS = 86_400_000;

@Injectable()
export class FloorSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(user: AuthUser): Promise<FloorSnapshotWire> {
    // Taken for the signature's sake: scoping is applied by the Prisma
    // company/branch extension from the request context, not from this
    // argument. Kept so the call site reads like every other report.
    void user;
    const now = new Date();
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    const staleBefore = new Date(now.getTime() - STALE_DAYS * DAY_MS);

    // Every figure below is over OPEN jobs of the caller's tenant. The
    // company-scope extension pins the company; branch users are additionally
    // pinned to their own branch by BRANCH_SCOPED_MODELS, so this filter is
    // about the lifecycle, not tenancy.
    const open: Prisma.JobWhereInput = {
      deletedAt: null,
      state: { isTerminal: false },
    };
    const overdue: Prisma.JobWhereInput = {
      ...open,
      slaDueAt: { lt: now },
    };

    const [
      openCount,
      overdueCount,
      dueTodayCount,
      urgentCount,
      unassignedCount,
      staleCount,
      stateGroups,
      overdueStateGroups,
      lineGroups,
      overdueLineGroups,
      priorityGroups,
      engineerGroups,
      overdueEngineerGroups,
      states,
      categories,
      engineers,
    ] = await Promise.all([
      this.prisma.job.count({ where: open }),
      this.prisma.job.count({ where: overdue }),
      this.prisma.job.count({
        where: { ...open, slaDueAt: { gte: now, lte: endOfToday } },
      }),
      this.prisma.job.count({
        where: { ...open, priority: { in: ['HIGH', 'URGENT'] } },
      }),
      this.prisma.job.count({ where: { ...open, assignedEngineerId: null } }),
      this.prisma.job.count({
        where: { ...open, receivedAt: { lt: staleBefore } },
      }),
      this.prisma.job.groupBy({
        by: ['stateId'],
        where: open,
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['stateId'],
        where: overdue,
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['serviceCategoryId'],
        where: open,
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['serviceCategoryId'],
        where: overdue,
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['priority'],
        where: open,
        _count: { _all: true },
      }),
      this.prisma.job.groupBy({
        by: ['assignedEngineerId'],
        where: open,
        _count: { _all: true },
        _min: { receivedAt: true },
      }),
      this.prisma.job.groupBy({
        by: ['assignedEngineerId'],
        where: overdue,
        _count: { _all: true },
      }),
      this.prisma.workflowState.findMany({ where: { deletedAt: null } }),
      this.prisma.serviceCategory.findMany({ where: { deletedAt: null } }),
      this.prisma.user.findMany({
        select: { id: true, fullName: true, initials: true },
      }),
    ]);

    const overdueByState = new Map(
      overdueStateGroups.map((g) => [g.stateId, g._count._all]),
    );
    const stateById = new Map(states.map((s) => [s.id, s]));
    const by_state = stateGroups
      .map((g) => {
        const s = stateById.get(g.stateId);
        return {
          code: s?.code ?? 'UNKNOWN',
          label: s?.label ?? 'Unknown',
          sort_order: s?.sortOrder ?? 0,
          count: g._count._all,
          overdue: overdueByState.get(g.stateId) ?? 0,
        };
      })
      .sort((a, b) => a.sort_order - b.sort_order);

    const overdueByLine = new Map(
      overdueLineGroups.map((g) => [g.serviceCategoryId, g._count._all]),
    );
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const by_line = lineGroups
      .map((g) => ({
        service_category_id: g.serviceCategoryId,
        // Jobs booked before service lines existed have none — surfaced
        // rather than dropped, because "not set" is itself worth seeing.
        label: g.serviceCategoryId
          ? (categoryById.get(g.serviceCategoryId)?.label ?? 'Unknown')
          : 'Not set',
        count: g._count._all,
        overdue: overdueByLine.get(g.serviceCategoryId) ?? 0,
      }))
      .sort((a, b) => b.count - a.count);

    const overdueByEngineer = new Map(
      overdueEngineerGroups.map((g) => [g.assignedEngineerId, g._count._all]),
    );
    const userById = new Map(engineers.map((u) => [u.id, u]));
    const engineerRows = engineerGroups
      .map((g) => {
        const u = g.assignedEngineerId
          ? userById.get(g.assignedEngineerId)
          : null;
        const oldest = g._min.receivedAt;
        return {
          engineer_id: g.assignedEngineerId,
          name: g.assignedEngineerId
            ? (u?.fullName ?? 'Unknown')
            : 'Unassigned',
          initials: u?.initials ?? null,
          active: g._count._all,
          overdue: overdueByEngineer.get(g.assignedEngineerId) ?? 0,
          oldest_days: oldest
            ? Math.floor((now.getTime() - oldest.getTime()) / DAY_MS)
            : null,
        };
      })
      // Busiest first, but the unassigned pile always leads: it is the one
      // nobody owns, so it is the one that goes unnoticed.
      .sort((a, b) => {
        if (a.engineer_id === null) return -1;
        if (b.engineer_id === null) return 1;
        return b.active - a.active;
      });

    return {
      at: now.toISOString(),
      attention: {
        open: openCount,
        overdue: overdueCount,
        due_today: dueTodayCount,
        urgent: urgentCount,
        unassigned: unassignedCount,
        stale: staleCount,
      },
      aging: await this.aging(open, now),
      by_state,
      by_line,
      priority_mix: priorityGroups
        .map((g) => ({ priority: g.priority, count: g._count._all }))
        .sort(
          (a, b) =>
            PRIORITY_ORDER.indexOf(a.priority) -
            PRIORITY_ORDER.indexOf(b.priority),
        ),
      engineers: engineerRows,
    };
  }

  /**
   * Open jobs bucketed by age since intake.
   *
   * One count per bucket rather than pulling every open row: a branch can hold
   * thousands of open jobs, and the client only ever renders four numbers.
   */
  private async aging(
    open: Prisma.JobWhereInput,
    now: Date,
  ): Promise<{ bucket: string; count: number }[]> {
    const counts = await Promise.all(
      AGE_BUCKETS.map((b) => {
        // Older bound = further in the past, so min days → the LATER date.
        const newest = new Date(now.getTime() - b.min * DAY_MS);
        const oldest =
          b.max === null
            ? null
            : new Date(now.getTime() - (b.max + 1) * DAY_MS);
        return this.prisma.job.count({
          where: {
            ...open,
            receivedAt: {
              lte: newest,
              ...(oldest ? { gt: oldest } : {}),
            },
          },
        });
      }),
    );
    return AGE_BUCKETS.map((b, i) => ({ bucket: b.label, count: counts[i] }));
  }
}

const PRIORITY_ORDER = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
