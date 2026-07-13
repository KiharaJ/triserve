import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Operations / BI report (Phase 5 / E15 + E5) over the repair pipeline: intake
 * trend, workflow-state mix, top device models, per-branch load, and per-
 * technician performance (assigned / completed / active / average turnaround).
 * Everything is a live aggregation over jobs — nothing stored. Branch-scoped
 * users are narrowed to their own branch.
 */
export interface OperationsReportWire {
  from: string | null;
  to: string | null;
  totals: {
    total_jobs: number;
    active_jobs: number;
    avg_turnaround_hours: number | null;
  };
  intake_by_month: { month: string; count: number }[];
  by_state: { code: string; label: string; is_terminal: boolean; count: number }[];
  by_branch: { code: string; name: string; count: number }[];
  top_models: { model: string; count: number }[];
  technicians: {
    engineer_id: string;
    name: string;
    initials: string | null;
    assigned: number;
    completed: number;
    active: number;
    avg_turnaround_hours: number | null;
  }[];
}

function n(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}
function nn(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
}

@Injectable()
export class OperationsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    user: AuthUser,
    from?: string,
    to?: string,
  ): Promise<OperationsReportWire> {
    const companyId = user.companyId;
    const branchId = user.scope === 'branch' ? user.homeBranchId : null;

    // Shared WHERE fragment on jobs `j`.
    const where: string[] = ['j.company_id = ?', 'j.deleted_at IS NULL'];
    const params: unknown[] = [companyId];
    if (branchId) {
      where.push('j.branch_id = ?');
      params.push(branchId);
    }
    if (from) {
      where.push('j.received_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('j.received_at <= ?');
      params.push(`${to} 23:59:59`);
    }
    const W = where.join(' AND ');

    const q = <T>(sql: string) =>
      this.prisma.$queryRawUnsafe<T>(sql, ...params);

    const [totals, intake, states, branches, models, techs] = await Promise.all([
      q<Array<{ total: bigint; active: bigint; avg_hours: number | null }>>(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN ws.is_terminal=0 THEN 1 ELSE 0 END) active,
                AVG(CASE WHEN j.dispatched_at IS NOT NULL
                         THEN TIMESTAMPDIFF(HOUR, j.received_at, j.dispatched_at) END) avg_hours
           FROM jobs j JOIN workflow_states ws ON ws.id = j.state_id WHERE ${W}`,
      ),
      q<Array<{ month: string; c: bigint }>>(
        `SELECT DATE_FORMAT(j.received_at,'%Y-%m') month, COUNT(*) c
           FROM jobs j WHERE ${W}
            AND j.received_at >= DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'), INTERVAL 11 MONTH)
          GROUP BY month ORDER BY month ASC`,
      ),
      q<Array<{ code: string; label: string; is_terminal: number; c: bigint }>>(
        `SELECT ws.code, ws.label, ws.is_terminal, COUNT(j.id) c
           FROM workflow_states ws
           LEFT JOIN jobs j ON j.state_id = ws.id AND ${W}
          WHERE ws.active = 1 AND ws.deleted_at IS NULL
          GROUP BY ws.code, ws.label, ws.is_terminal, ws.sort_order
          ORDER BY ws.sort_order ASC`,
      ),
      q<Array<{ code: string; name: string; c: bigint }>>(
        `SELECT b.code, b.name, COUNT(*) c
           FROM jobs j JOIN branches b ON b.id = j.branch_id WHERE ${W}
          GROUP BY b.code, b.name ORDER BY c DESC`,
      ),
      q<Array<{ model: string; c: bigint }>>(
        `SELECT COALESCE(NULLIF(d.model,''),'Unknown') model, COUNT(*) c
           FROM jobs j JOIN devices d ON d.id = j.device_id WHERE ${W}
          GROUP BY model ORDER BY c DESC LIMIT 10`,
      ),
      q<
        Array<{
          id: string;
          full_name: string;
          initials: string | null;
          assigned: bigint;
          completed: bigint;
          active: bigint;
          avg_hours: number | null;
        }>
      >(
        `SELECT u.id, u.full_name, u.initials,
                COUNT(j.id) assigned,
                SUM(ws.is_terminal) completed,
                SUM(CASE WHEN ws.is_terminal=0 THEN 1 ELSE 0 END) active,
                AVG(CASE WHEN j.dispatched_at IS NOT NULL
                         THEN TIMESTAMPDIFF(HOUR, j.received_at, j.dispatched_at) END) avg_hours
           FROM users u
           JOIN jobs j ON j.assigned_engineer_id = u.id AND ${W}
           JOIN workflow_states ws ON ws.id = j.state_id
          GROUP BY u.id, u.full_name, u.initials
          ORDER BY assigned DESC`,
      ),
    ]);

    return {
      from: from ?? null,
      to: to ?? null,
      totals: {
        total_jobs: n(totals[0]?.total),
        active_jobs: n(totals[0]?.active),
        avg_turnaround_hours: nn(totals[0]?.avg_hours),
      },
      intake_by_month: intake.map((r) => ({ month: r.month, count: n(r.c) })),
      by_state: states.map((r) => ({
        code: r.code,
        label: r.label,
        is_terminal: Boolean(r.is_terminal),
        count: n(r.c),
      })),
      by_branch: branches.map((r) => ({ code: r.code, name: r.name, count: n(r.c) })),
      top_models: models.map((r) => ({ model: r.model, count: n(r.c) })),
      technicians: techs.map((r) => ({
        engineer_id: r.id,
        name: r.full_name,
        initials: r.initials,
        assigned: n(r.assigned),
        completed: n(r.completed),
        active: n(r.active),
        avg_turnaround_hours: nn(r.avg_hours),
      })),
    };
  }
}
