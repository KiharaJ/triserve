import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Dashboard analytics (§8). One roll-up query set powering the operations
 * home screen — server-side SQL aggregation so it stays fast over tens of
 * thousands of rows (the list endpoints cap at 100/page and can't sum).
 *
 * Everything is company-scoped by the caller's JWT; branch-scoped users are
 * additionally narrowed to their home branch so a technician sees their shop,
 * not the whole group. Money is returned as minor-unit STRINGS per currency
 * (USD billed through Samsung's system vs. TZS cash are never summed together).
 */
export interface MoneyByCurrency {
  currency: string;
  amount: string; // minor units
  count: number;
}
export interface MonthlyPoint {
  month: string; // 'YYYY-MM'
  currency: string;
  amount: string;
}
export interface NamedTotal {
  key: string;
  label: string;
  currency: string;
  amount: string;
  count: number;
}
export interface StageCount {
  code: string;
  label: string;
  count: number;
  is_terminal: boolean;
}
export interface DashboardSummary {
  generated_at: string;
  scope: { branch_id: string | null };
  revenue_all_time: MoneyByCurrency[];
  revenue_this_month: MoneyByCurrency[];
  monthly: MonthlyPoint[];
  by_method: NamedTotal[];
  by_branch: NamedTotal[];
  jobs_by_state: StageCount[];
  jobs_active: number;
  jobs_total: number;
  counts: {
    customers: number;
    devices: number;
    parts: number;
    stock_on_hand: number;
    low_stock: number;
    open_invoices: number;
  };
}

/** Narrow a raw bigint/decimal count to a JS number. */
function n(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}
function s(v: unknown): string {
  return v === null || v === undefined ? '0' : String(v);
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: AuthUser): Promise<DashboardSummary> {
    const companyId = user.companyId;
    // Branch-scoped staff see only their branch; group staff see the company.
    const branchId = user.scope === 'branch' ? user.homeBranchId : null;
    const branchFilter = branchId ? `AND p.branch_id = '${branchId}'` : '';
    const invBranchFilter = branchId ? `AND i.branch_id = '${branchId}'` : '';

    // Paid revenue, all time, grouped by currency.
    const revenueAll = await this.prisma.$queryRawUnsafe<
      Array<{ currency: string; amount: bigint; cnt: bigint }>
    >(
      `SELECT p.currency, SUM(p.amount) amount, COUNT(*) cnt
         FROM payments p
        WHERE p.company_id = ? ${branchFilter}
        GROUP BY p.currency`,
      companyId,
    );

    const revenueMonth = await this.prisma.$queryRawUnsafe<
      Array<{ currency: string; amount: bigint; cnt: bigint }>
    >(
      `SELECT p.currency, SUM(p.amount) amount, COUNT(*) cnt
         FROM payments p
        WHERE p.company_id = ? ${branchFilter}
          AND p.paid_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
        GROUP BY p.currency`,
      companyId,
    );

    // Last 12 months of takings, per currency.
    const monthly = await this.prisma.$queryRawUnsafe<
      Array<{ month: string; currency: string; amount: bigint }>
    >(
      `SELECT DATE_FORMAT(p.paid_at, '%Y-%m') month, p.currency, SUM(p.amount) amount
         FROM payments p
        WHERE p.company_id = ? ${branchFilter}
          AND p.paid_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
        GROUP BY month, p.currency
        ORDER BY month ASC`,
      companyId,
    );

    const byMethod = await this.prisma.$queryRawUnsafe<
      Array<{ method: string; currency: string; amount: bigint; cnt: bigint }>
    >(
      `SELECT p.method, p.currency, SUM(p.amount) amount, COUNT(*) cnt
         FROM payments p
        WHERE p.company_id = ? ${branchFilter}
        GROUP BY p.method, p.currency
        ORDER BY amount DESC`,
      companyId,
    );

    const byBranch = await this.prisma.$queryRawUnsafe<
      Array<{ code: string; name: string; currency: string; amount: bigint; cnt: bigint }>
    >(
      `SELECT b.code, b.name, p.currency, SUM(p.amount) amount, COUNT(*) cnt
         FROM payments p
         JOIN branches b ON b.id = p.branch_id
        WHERE p.company_id = ? ${branchFilter}
        GROUP BY b.code, b.name, p.currency
        ORDER BY amount DESC`,
      companyId,
    );

    // Jobs by workflow state (active = non-terminal).
    const jobStates = await this.prisma.$queryRawUnsafe<
      Array<{ code: string; label: string; is_terminal: boolean | number; cnt: bigint }>
    >(
      `SELECT ws.code, ws.label, ws.is_terminal, COUNT(j.id) cnt
         FROM workflow_states ws
         LEFT JOIN jobs j
           ON j.state_id = ws.id AND j.company_id = ? AND j.deleted_at IS NULL
              ${branchId ? "AND j.branch_id = '" + branchId + "'" : ''}
        WHERE ws.active = 1 AND ws.deleted_at IS NULL
        GROUP BY ws.code, ws.label, ws.is_terminal, ws.sort_order
        ORDER BY ws.sort_order ASC`,
      companyId,
    );

    const counts = await this.prisma.$queryRawUnsafe<
      Array<{ customers: bigint; devices: bigint; parts: bigint }>
    >(
      `SELECT
         (SELECT COUNT(*) FROM customers WHERE company_id = ? AND deleted_at IS NULL) customers,
         (SELECT COUNT(*) FROM devices   WHERE company_id = ? AND deleted_at IS NULL) devices,
         (SELECT COUNT(*) FROM parts     WHERE company_id = ? AND deleted_at IS NULL) parts`,
      companyId,
      companyId,
      companyId,
    );

    const stock = await this.prisma.$queryRawUnsafe<
      Array<{ on_hand: bigint; low: bigint }>
    >(
      `SELECT
         COALESCE(SUM(i.qty_on_hand), 0) on_hand,
         SUM(CASE WHEN i.qty_on_hand <= i.reorder_level AND i.reorder_level > 0 THEN 1 ELSE 0 END) low
         FROM inventory i
        WHERE i.company_id = ? ${invBranchFilter}`,
      companyId,
    );

    const openInv = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
      `SELECT COUNT(*) cnt FROM invoices i
        WHERE i.company_id = ? AND i.deleted_at IS NULL
          AND i.status IN ('DRAFT','PARTIAL') ${invBranchFilter}`,
      companyId,
    );

    const jobsByState: StageCount[] = jobStates.map((r) => ({
      code: r.code,
      label: r.label,
      count: n(r.cnt),
      is_terminal: Boolean(r.is_terminal),
    }));

    return {
      generated_at: new Date().toISOString(),
      scope: { branch_id: branchId },
      revenue_all_time: revenueAll.map((r) => ({
        currency: r.currency,
        amount: s(r.amount),
        count: n(r.cnt),
      })),
      revenue_this_month: revenueMonth.map((r) => ({
        currency: r.currency,
        amount: s(r.amount),
        count: n(r.cnt),
      })),
      monthly: monthly.map((r) => ({
        month: r.month,
        currency: r.currency,
        amount: s(r.amount),
      })),
      by_method: byMethod.map((r) => ({
        key: r.method,
        label: r.method,
        currency: r.currency,
        amount: s(r.amount),
        count: n(r.cnt),
      })),
      by_branch: byBranch.map((r) => ({
        key: r.code,
        label: r.name,
        currency: r.currency,
        amount: s(r.amount),
        count: n(r.cnt),
      })),
      jobs_by_state: jobsByState,
      jobs_active: jobsByState.filter((j) => !j.is_terminal).reduce((a, b) => a + b.count, 0),
      jobs_total: jobsByState.reduce((a, b) => a + b.count, 0),
      counts: {
        customers: n(counts[0]?.customers),
        devices: n(counts[0]?.devices),
        parts: n(counts[0]?.parts),
        stock_on_hand: n(stock[0]?.on_hand),
        low_stock: n(stock[0]?.low),
        open_invoices: n(openInv[0]?.cnt),
      },
    };
  }
}
