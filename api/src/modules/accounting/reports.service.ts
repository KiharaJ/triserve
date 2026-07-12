import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * Financial reports (Phase 5 / E1) computed live off the double-entry ledger:
 * a Trial Balance and a Profit & Loss. Both are grouped BY CURRENCY — the
 * ledger holds TZS (cash/POS) and USD (Samsung warranty) side by side and they
 * are never summed without an fx rate (§14.11), so each currency reports on its
 * own. Nothing is stored; every figure is a SUM over journal_lines.
 */
export interface TbRow {
  code: string;
  name: string;
  type: string;
  debit: string;
  credit: string;
  balance: string; // debit − credit (minor units)
}
export interface TrialBalanceCurrency {
  currency: string;
  rows: TbRow[];
  total_debit: string;
  total_credit: string;
  balanced: boolean;
}
export interface TrialBalanceWire {
  from: string | null;
  to: string | null;
  currencies: TrialBalanceCurrency[];
}

export interface PlLine {
  code: string;
  name: string;
  amount: string;
}
export interface ProfitLossCurrency {
  currency: string;
  revenue: PlLine[];
  total_revenue: string;
  expenses: PlLine[];
  total_expenses: string;
  net_profit: string;
}
export interface ProfitLossWire {
  from: string | null;
  to: string | null;
  currencies: ProfitLossCurrency[];
}

interface RawRow {
  code: string;
  name: string;
  type: string;
  currency: string;
  debit: bigint | number;
  credit: bigint | number;
}

function b(v: bigint | number): bigint {
  return typeof v === 'bigint' ? v : BigInt(Math.round(Number(v)));
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sum debit/credit per account+currency over the ledger (optional period). */
  private async ledgerRows(
    companyId: string,
    from?: string,
    to?: string,
  ): Promise<RawRow[]> {
    const params: unknown[] = [companyId];
    let sql = `
      SELECT a.code, a.name, a.type, jl.currency,
             SUM(jl.debit) AS debit, SUM(jl.credit) AS credit
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN chart_of_accounts a ON a.id = jl.account_id
       WHERE je.company_id = ?`;
    if (from) {
      sql += ' AND je.entry_date >= ?';
      params.push(from);
    }
    if (to) {
      sql += ' AND je.entry_date <= ?';
      params.push(to);
    }
    sql += ' GROUP BY a.code, a.name, a.type, jl.currency ORDER BY jl.currency, a.code';
    return this.prisma.$queryRawUnsafe<RawRow[]>(sql, ...params);
  }

  async trialBalance(
    user: AuthUser,
    from?: string,
    to?: string,
  ): Promise<TrialBalanceWire> {
    const rows = await this.ledgerRows(user.companyId, from, to);
    const byCurrency = new Map<string, TbRow[]>();
    for (const r of rows) {
      const debit = b(r.debit);
      const credit = b(r.credit);
      const list = byCurrency.get(r.currency) ?? [];
      list.push({
        code: r.code,
        name: r.name,
        type: r.type,
        debit: debit.toString(),
        credit: credit.toString(),
        balance: (debit - credit).toString(),
      });
      byCurrency.set(r.currency, list);
    }

    const currencies: TrialBalanceCurrency[] = [...byCurrency.entries()].map(
      ([currency, list]) => {
        const totalDebit = list.reduce((s, x) => s + BigInt(x.debit), 0n);
        const totalCredit = list.reduce((s, x) => s + BigInt(x.credit), 0n);
        return {
          currency,
          rows: list,
          total_debit: totalDebit.toString(),
          total_credit: totalCredit.toString(),
          balanced: totalDebit === totalCredit,
        };
      },
    );
    return { from: from ?? null, to: to ?? null, currencies };
  }

  async profitLoss(
    user: AuthUser,
    from?: string,
    to?: string,
  ): Promise<ProfitLossWire> {
    const rows = await this.ledgerRows(user.companyId, from, to);
    const byCurrency = new Map<
      string,
      { revenue: PlLine[]; expenses: PlLine[] }
    >();
    for (const r of rows) {
      if (r.type !== 'REVENUE' && r.type !== 'EXPENSE') continue;
      const debit = b(r.debit);
      const credit = b(r.credit);
      const bucket =
        byCurrency.get(r.currency) ?? { revenue: [], expenses: [] };
      if (r.type === 'REVENUE') {
        // revenue is credit-normal
        const amt = credit - debit;
        if (amt !== 0n)
          bucket.revenue.push({ code: r.code, name: r.name, amount: amt.toString() });
      } else {
        // expense is debit-normal
        const amt = debit - credit;
        if (amt !== 0n)
          bucket.expenses.push({ code: r.code, name: r.name, amount: amt.toString() });
      }
      byCurrency.set(r.currency, bucket);
    }

    const currencies: ProfitLossCurrency[] = [...byCurrency.entries()].map(
      ([currency, { revenue, expenses }]) => {
        const totalRevenue = revenue.reduce((s, x) => s + BigInt(x.amount), 0n);
        const totalExpenses = expenses.reduce((s, x) => s + BigInt(x.amount), 0n);
        return {
          currency,
          revenue,
          total_revenue: totalRevenue.toString(),
          expenses,
          total_expenses: totalExpenses.toString(),
          net_profit: (totalRevenue - totalExpenses).toString(),
        };
      },
    );
    return { from: from ?? null, to: to ?? null, currencies };
  }
}
