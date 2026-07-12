import { BadRequestException, Injectable } from '@nestjs/common';
import { type WarrantyClaimStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { WarrantyClaimsService } from './warranty-claims.service';

/**
 * GSPN bridge (Phase 4 / E13) — a CSV data-exchange with Samsung's Global
 * Service Partner Network until real API access is granted. It is the manual
 * implementation of the E13 "Samsung gateway": the same operations (file claims,
 * reconcile reimbursements) a live GSPN adapter would perform, done over CSV.
 *
 *   - export: claims (default SUBMITTED) → a CSV to upload / reconcile in GSPN;
 *   - import: GSPN's decision file (claim_no, outcome, reimbursed_usd) → drives
 *     each claim through {@link WarrantyClaimsService.reconcile}, so the ledger
 *     postings (Dr AR–Samsung / Cr Warranty Revenue; Dr Bank / Cr AR–Samsung)
 *     fire exactly as they do in the UI. Per-row, best-effort with a report.
 */
export interface GspnImportRow {
  claim_no: string;
  outcome: string;
  reimbursed_usd?: string;
}
export interface GspnImportReport {
  total: number;
  applied: number;
  errors: Array<{ claim_no: string; reason: string }>;
}

const EXPORT_HEADERS = [
  'claim_no',
  'job_no',
  'imei_serial',
  'model',
  'labour_code',
  'claim_usd',
  'status',
  'submitted_at',
  'branch_code',
];

@Injectable()
export class GspnBridgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: WarrantyClaimsService,
  ) {}

  /** Build a GSPN-upload CSV of claims (default: everything SUBMITTED). */
  async exportCsv(status: string | undefined, user: AuthUser): Promise<string> {
    const rows = await this.prisma.warrantyClaim.findMany({
      where: {
        companyId: user.companyId,
        deletedAt: null,
        status: (status as WarrantyClaimStatus) ?? 'SUBMITTED',
      },
      include: {
        branch: { select: { code: true } },
        job: { include: { device: { select: { imeiSerial: true, model: true } } } },
      },
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
    });

    const lines = [EXPORT_HEADERS.join(',')];
    for (const c of rows) {
      lines.push(
        [
          c.claimNo ?? '',
          c.job.jobNo,
          c.job.device.imeiSerial ?? '',
          c.job.device.model ?? '',
          c.labourCode ?? '',
          centsToUsd(c.claimAmountUsd),
          c.status,
          c.submittedAt ? c.submittedAt.toISOString().slice(0, 10) : '',
          c.branch.code,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Apply a GSPN reconciliation CSV. Columns (header row required):
   *   claim_no, outcome (APPROVED|REJECTED|PAID), reimbursed_usd (optional $).
   * Matches claims by claim_no within the company; each row is reconciled
   * independently — a bad row is reported, the rest still apply.
   */
  async importReconciliations(
    csv: string,
    user: AuthUser,
  ): Promise<GspnImportReport> {
    const records = parseCsv(csv);
    const report: GspnImportReport = { total: records.length, applied: 0, errors: [] };

    for (const r of records) {
      const claimNo = (r.claim_no ?? '').trim();
      const outcome = (r.outcome ?? '').trim().toUpperCase();
      if (!claimNo) {
        report.errors.push({ claim_no: '(blank)', reason: 'missing claim_no' });
        continue;
      }
      if (!['APPROVED', 'REJECTED', 'PAID'].includes(outcome)) {
        report.errors.push({ claim_no: claimNo, reason: `invalid outcome "${r.outcome}"` });
        continue;
      }
      const claim = await this.prisma.warrantyClaim.findFirst({
        where: { companyId: user.companyId, claimNo, deletedAt: null },
        select: { id: true },
      });
      if (!claim) {
        report.errors.push({ claim_no: claimNo, reason: 'no matching claim' });
        continue;
      }

      let reimbursed: string | undefined;
      if (outcome === 'PAID' && (r.reimbursed_usd ?? '').trim() !== '') {
        try {
          reimbursed = usdToCents(r.reimbursed_usd as string);
        } catch {
          report.errors.push({ claim_no: claimNo, reason: `bad reimbursed_usd "${r.reimbursed_usd}"` });
          continue;
        }
      }

      try {
        await this.claims.reconcile(
          claim.id,
          {
            outcome: outcome as 'APPROVED' | 'REJECTED' | 'PAID',
            reimbursed_amount_usd: reimbursed,
          },
          user,
        );
        report.applied++;
      } catch (e) {
        report.errors.push({
          claim_no: claimNo,
          reason: e instanceof Error ? e.message : 'reconcile failed',
        });
      }
    }
    return report;
  }
}

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/** USD minor units (cents) → "95.00". */
function centsToUsd(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
/** "$95.00" / "95" → cents string. Throws on non-numeric. */
function usdToCents(v: string): string {
  const t = v.replace(/[$,\s]/g, '').trim();
  const m = t.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new BadRequestException(`not a USD amount: "${v}"`);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return (BigInt(m[1]) * 100n + BigInt(frac || '0')).toString();
}

/** Minimal RFC-4180-ish CSV → array of {header: value}; headers lower-cased. */
function parseCsv(text: string): GspnImportRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => (rec[h] = (r[idx] ?? '').trim()));
    return rec as unknown as GspnImportRow;
  });
}
