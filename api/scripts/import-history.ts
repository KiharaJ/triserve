/**
 * Historical data importer (real Excel workbooks → live tables).
 *
 * Loads two very different bodies of real data the shop kept in spreadsheets:
 *
 *   A. SALES history (4 branch daily-sales workbooks: Kariakoo, Mlimani,
 *      Arusha, Dodoma). Each sheet's BANNER names the branch (files overlap, so
 *      branch is derived per-sheet, never from the filename) and whether it is
 *      MX (mobile) or CE (consumer-electronics) sales. Every sale line carries
 *      up to two money streams — USD (billed through Samsung's system / warranty
 *      parts) and TZS (cash collected). Each non-zero stream becomes one PAID
 *      invoice in its native currency, with a matching payment. Rows are
 *      de-duplicated by a natural key so overlapping sheets don't double-count.
 *
 *   B. Dar JOB-intake (customer + device + defect booking log). Each row →
 *      upserted Customer + Device (+ Job at DAR in the initial workflow state).
 *
 * Idempotent: invoice_no / job_no are deterministic content hashes with an
 * "H" prefix (so they never collide with app-generated INV-…/DAR-… numbers);
 * a re-run skips anything already present. Customers/devices are matched by
 * normalized phone / IMEI. Historical invoices intentionally do NOT post to the
 * journal (bulk back-fill; the ledger goes live from real-time payments).
 *
 *   npm run import:history -- [--dir ~/Downloads] [--only sales|jobs] [--dry]
 *                            [--company "Samsung ASC Group"] [--limit N]
 */
import { PrismaClient, type DeviceCategory } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  normalizeImeiSerial,
  normalizePhone,
} from '../src/common/util/phone';

const prisma = new PrismaClient();

// ─── args ────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry');
const ONLY = arg('only'); // 'sales' | 'jobs' | undefined (both)
const COMPANY_NAME = arg('company') ?? 'Samsung ASC Group';
const DIR = (arg('dir') ?? join(homedir(), 'Downloads')).replace(/^~/, homedir());
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity;

const SALES_FILES = [
  '3.07.2026 KARIAKOO ASC BRANCH_DAILY SALES REPORT (7).xlsx',
  'MLIMANI DAILY SALES REPORT 04.07.2026.xlsx',
  'ARUSHA ASC BRANCH_DAILY SALES REPORT (04.07.2026).xlsx',
  'DODOMA SALES REPORT 04.07.2026.xlsx',
];
const DAR_FILE = 'DAR DAILY  REPORTS DATA BASE NOV 25.xlsx';

// ─── helpers ─────────────────────────────────────────────────────────────────
type Grid = Array<Array<unknown>>;

function sheetGrid(file: string, sheet: string): Grid {
  const wb = XLSX.read(readFileSync(join(DIR, file)), {
    type: 'buffer',
    cellDates: true,
  });
  return XLSX.utils.sheet_to_json(wb.Sheets[sheet], {
    header: 1,
    defval: null,
    blankrows: false,
  });
}
function sheetNames(file: string): string[] {
  return XLSX.read(readFileSync(join(DIR, file)), { type: 'buffer' }).SheetNames;
}
function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}
function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
/** Find the header row index (a row that has a cell equal to "DATE"). */
function headerRow(grid: Grid): number {
  return grid.findIndex((r) =>
    (r ?? []).some((c) => str(c).toUpperCase() === 'DATE'),
  );
}
/** Map lower-cased header label → column index (first match wins). */
function headerIndex(row: Array<unknown>): Map<string, number> {
  const m = new Map<string, number>();
  row.forEach((c, i) => {
    const k = str(c).toUpperCase();
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}
/** First column whose header CONTAINS any of the needles. */
function findCol(idx: Map<string, number>, needles: string[]): number {
  for (const [k, i] of idx) if (needles.some((n) => k.includes(n))) return i;
  return -1;
}

/** Parse "DD.MM.YYYY" / "DD.MM.YY" / Date → Date (midnight), or null. */
/** A received/sale date can't be in the future — reject beyond tomorrow so a
 * garbled source string (e.g. "28.04.29") doesn't land in 2029 AND poison the
 * following carry-forward rows; those rows fall back to the last valid date. */
const MAX_DATE = Date.now() + 86_400_000;
function parseDate(v: unknown): Date | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return v.getTime() > MAX_DATE ? null : v;
  }
  const s = str(v);
  const m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 2020 || y > 2035) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getTime() > MAX_DATE ? null : dt;
}
/** Month/year from a Dar sheet name like "CASH JULAY 26" → Date(1st) or null. */
const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, APRIL: 3, MAY: 4, JUN: 5, JUNE: 5,
  JUL: 6, JULY: 6, JULAY: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
function sheetMonthDate(name: string): Date | null {
  const u = name.toUpperCase();
  let mo = -1;
  for (const [k, v] of Object.entries(MONTHS)) if (u.includes(k)) { mo = v; break; }
  if (mo < 0) return null;
  const ym = u.match(/\b(\d{2,4})\b/);
  let y = ym ? Number(ym[1]) : 2026;
  if (y < 100) y += 2000;
  return new Date(Date.UTC(y, mo, 1));
}

function hash(parts: string[]): string {
  return createHash('md5').update(parts.join('')).digest('hex').slice(0, 16);
}
function toCategory(v: string): DeviceCategory {
  const u = v.trim().toUpperCase();
  if (u === 'MX' || u === 'HHP') return 'HHP';
  if (u === 'CE') return 'CE';
  if (u === 'AC') return 'AC';
  if (u === 'REF') return 'REF';
  return 'OTHER';
}
function branchFromBanner(banner: string): string | null {
  const u = banner.toUpperCase();
  if (u.includes('KARIAKOO')) return 'KRK';
  if (u.includes('MLIMANI')) return 'MLM';
  if (u.includes('ARUSHA')) return 'ARU';
  if (u.includes('DODOMA')) return 'DOD';
  return null;
}

// ─── context (company, branches, users, initial state) ───────────────────────
interface Ctx {
  companyId: string;
  actorId: string;
  branchById: Map<string, { id: string; code: string }>; // code → {id, code}
  userByBranch: Map<string, string>; // branch code → a user id at that branch
  initialStateId: string;
}

async function loadCtx(): Promise<Ctx> {
  const company = await prisma.company.findFirst({ where: { name: COMPANY_NAME } });
  if (!company) throw new Error(`Company not found: "${COMPANY_NAME}"`);
  const admin = await prisma.user.findFirst({
    where: { companyId: company.id, role: 'SUPER_ADMIN' },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error('No SUPER_ADMIN user to attribute imports to');

  const branches = await prisma.branch.findMany({ where: { companyId: company.id } });
  const branchById = new Map(branches.map((b) => [b.code.toUpperCase(), { id: b.id, code: b.code }]));

  const userByBranch = new Map<string, string>();
  for (const b of branches) {
    const u = await prisma.user.findFirst({
      where: { companyId: company.id, homeBranchId: b.id },
      orderBy: { createdAt: 'asc' },
    });
    userByBranch.set(b.code.toUpperCase(), u?.id ?? admin.id);
  }

  const initial = await prisma.workflowState.findFirst({
    where: { isInitial: true, active: true, deletedAt: null },
  });
  if (!initial) throw new Error('No initial workflow state configured');

  return {
    companyId: company.id,
    actorId: admin.id,
    branchById,
    userByBranch,
    initialStateId: initial.id,
  };
}

// ═══ PART A: sales → invoices + payments ═════════════════════════════════════
interface SalesReport {
  invoicesCreated: number;
  invoicesSkipped: number; // already present (idempotent re-run)
  usdInvoices: number;
  tzsInvoices: number;
  usdCents: bigint;
  tzsSenti: bigint;
  rowsSkipped: number;
  perBranch: Map<string, number>;
}

async function importSales(ctx: Ctx): Promise<SalesReport> {
  const rep: SalesReport = {
    invoicesCreated: 0, invoicesSkipped: 0, usdInvoices: 0, tzsInvoices: 0,
    usdCents: 0n, tzsSenti: 0n, rowsSkipped: 0, perBranch: new Map(),
  };
  const seen = new Set<string>(); // natural-key dedup across overlapping sheets
  let processed = 0;

  for (const file of SALES_FILES) {
    for (const sheet of sheetNames(file)) {
      const grid = sheetGrid(file, sheet);
      const h = headerRow(grid);
      if (h < 0) continue;
      // Banner = any cell before/at the header mentioning a branch.
      let banner = '';
      for (const r of grid.slice(0, h + 1)) {
        for (const c of r ?? []) if (/SALES REPO/i.test(str(c))) { banner = str(c); break; }
        if (banner) break;
      }
      const branchCode = branchFromBanner(banner) ?? branchFromBanner(sheet) ?? null;
      const branch = branchCode ? ctx.branchById.get(branchCode) : undefined;
      if (!branch) continue; // unknown branch banner — skip whole sheet

      const section = /(^|\s)CE(\s|$)/i.test(banner) || /\bCE\b/i.test(sheet) ? 'CE' : 'MX';
      const idx = headerIndex(grid[h]);
      const cDate = findCol(idx, ['DATE']);
      const cDesc = findCol(idx, ['DESCRIPTION']);
      const cSo = findCol(idx, ['SO NUMBER', 'SO NO']);
      const cUnit = findCol(idx, ['UNIT PRICE']);
      const cQty = findCol(idx, ['QTY']);
      const cSys = findCol(idx, ['SYSTEM']);
      const cCash = findCol(idx, ['CASH']);
      const cEng = findCol(idx, ['ASS ENG', 'ENG']);

      let lastDate: Date | null = null;
      for (const r of grid.slice(h + 1)) {
        const desc = str(r[cDesc]);
        if (!desc || /TOTAL\s+AMOUNT/i.test(desc)) continue;
        const d = parseDate(r[cDate]);
        if (d) lastDate = d;
        const when = d ?? lastDate ?? sheetMonthDate(sheet);
        if (!when) { rep.rowsSkipped++; continue; }

        const so = cSo >= 0 ? str(r[cSo]) : '';
        const qty = Math.max(1, Math.round(num(r[cQty]) || 1));
        const eng = cEng >= 0 ? str(r[cEng]) : '';
        let usd = cSys >= 0 ? num(r[cSys]) : 0;
        if (usd <= 0 && cUnit >= 0) usd = num(r[cUnit]) * qty;
        const cash = cCash >= 0 ? num(r[cCash]) : 0;
        if (usd <= 0 && cash <= 0) continue;

        const dISO = when.toISOString().slice(0, 10);
        // Each currency stream → its own invoice.
        const streams: Array<{ ccy: 'USD' | 'TZS'; minor: bigint; method: 'BANK' | 'CASH'; warranty: boolean }> = [];
        if (usd > 0) streams.push({ ccy: 'USD', minor: BigInt(Math.round(usd * 100)), method: 'BANK', warranty: true });
        if (cash > 0) streams.push({ ccy: 'TZS', minor: BigInt(Math.round(cash * 100)), method: 'CASH', warranty: false });

        for (const s of streams) {
          const nat = `${branch.code}|${section}|${dISO}|${desc}|${so}|${s.ccy}|${s.minor}`;
          if (seen.has(nat)) continue;
          seen.add(nat);
          if (processed++ >= LIMIT) break;

          const invoiceNo = `H${branch.code}-${hash([nat])}`;
          if (DRY) {
            rep.invoicesCreated++;
          } else {
            const exists = await prisma.invoice.findUnique({
              where: { companyId_invoiceNo: { companyId: ctx.companyId, invoiceNo } },
              select: { id: true },
            });
            if (exists) { rep.invoicesSkipped++; continue; }
            const soldBy = ctx.userByBranch.get(branch.code) ?? ctx.actorId;
            const noteBits = [
              `Imported ${section} sale`,
              so ? `SO ${so}` : '',
              eng ? `eng ${eng}` : '',
            ].filter(Boolean);
            await prisma.invoice.create({
              data: {
                id: randomUUID(),
                companyId: ctx.companyId,
                invoiceNo,
                branchId: branch.id,
                type: s.ccy === 'USD' ? 'PARTS_SALE' : 'REPAIR_OW',
                currency: s.ccy,
                subtotal: s.minor,
                discount: 0n,
                tax: 0n,
                total: s.minor,
                status: 'PAID',
                soldById: soldBy,
                notes: noteBits.join('; '),
                createdAt: when,
                createdById: ctx.actorId,
                updatedById: ctx.actorId,
                lines: {
                  create: [{
                    id: randomUUID(),
                    lineType: s.ccy === 'USD' ? 'PART' : 'SERVICE',
                    description: desc.slice(0, 500),
                    qty,
                    unitPrice: s.minor / BigInt(qty),
                    lineTotal: s.minor,
                    isWarranty: s.warranty,
                    createdAt: when,
                  }],
                },
                payments: {
                  create: [{
                    id: randomUUID(),
                    companyId: ctx.companyId,
                    branchId: branch.id,
                    method: s.method,
                    amount: s.minor,
                    currency: s.ccy,
                    reference: so || null,
                    paidAt: when,
                    receivedById: soldBy,
                    createdAt: when,
                  }],
                },
              },
            });
            rep.invoicesCreated++;
          }
          if (s.ccy === 'USD') { rep.usdInvoices++; rep.usdCents += s.minor; }
          else { rep.tzsInvoices++; rep.tzsSenti += s.minor; }
          rep.perBranch.set(branch.code, (rep.perBranch.get(branch.code) ?? 0) + 1);
        }
        if (processed >= LIMIT) break;
      }
      if (processed >= LIMIT) break;
    }
    if (processed >= LIMIT) break;
  }
  return rep;
}

// ═══ PART B: Dar → customers + devices + jobs ════════════════════════════════
interface JobsReport {
  customersCreated: number;
  devicesCreated: number;
  jobsCreated: number;
  jobsSkipped: number;
  rowsSkipped: number;
}

async function importDarJobs(ctx: Ctx): Promise<JobsReport> {
  const rep: JobsReport = {
    customersCreated: 0, devicesCreated: 0, jobsCreated: 0, jobsSkipped: 0, rowsSkipped: 0,
  };
  const dar = ctx.branchById.get('DAR');
  if (!dar) throw new Error('DAR branch not found');
  const bookedBy = ctx.userByBranch.get('DAR') ?? ctx.actorId;

  // Reuse across rows so the same person/device is not duplicated.
  const custByKey = new Map<string, string>(); // phoneNorm||name → customerId
  const devByImei = new Map<string, string>(); // imei → deviceId
  const jobSeen = new Set<string>();
  let processed = 0;

  // RECEIVE&DISPATCH is the master log; the CASH sheets are subsets — process
  // the master first so its rows win, then CASH sheets only add what's new.
  const ordered = sheetNames(DAR_FILE).sort((a, b) =>
    /RECEIVE/i.test(a) ? -1 : /RECEIVE/i.test(b) ? 1 : 0,
  );

  for (const sheet of ordered) {
    const grid = sheetGrid(DAR_FILE, sheet);
    const h = grid.findIndex((r) => (r ?? []).some((c) => /CUSTOMER NAME/i.test(str(c))));
    if (h < 0) continue;
    const idx = headerIndex(grid[h]);
    const cDate = findCol(idx, ['DATE']);
    const cName = findCol(idx, ['CUSTOMER NAME']);
    const cDealer = findCol(idx, ['DEALER']);
    const cWaybill = findCol(idx, ['WAYBILL']);
    const cModel = findCol(idx, ['MODEL']);
    const cCat = findCol(idx, ['CATEGORY']);
    const cImei = findCol(idx, ['IMEI']);
    const cBooked = findCol(idx, ['BOOKED']);
    const cColor = findCol(idx, ['COLOR', 'COLOUR']);
    const cLoc = findCol(idx, ['LOCATION']);
    const cPhone = findCol(idx, ['PHONE']);
    const cFault = findCol(idx, ['FAULT', 'DEFECT']);
    const monthFallback = sheetMonthDate(sheet);

    let lastDate: Date | null = null;
    for (const r of grid.slice(h + 1)) {
      const name = str(r[cName]);
      if (!name || /CUSTOMER NAME/i.test(name)) continue;
      const d = parseDate(r[cDate]);
      if (d) lastDate = d;
      const when = d ?? lastDate ?? monthFallback;
      if (!when) { rep.rowsSkipped++; continue; }
      if (processed++ >= LIMIT) break;

      const phoneRaw = cPhone >= 0 ? str(r[cPhone]) : '';
      const phoneNorm = normalizePhone(phoneRaw);
      const imei = cImei >= 0 ? normalizeImeiSerial(str(r[cImei])) : null;
      const model = cModel >= 0 ? str(r[cModel]) : '';
      const category = toCategory(cCat >= 0 ? str(r[cCat]) : 'HHP');
      const color = cColor >= 0 ? str(r[cColor]) : '';
      const location = cLoc >= 0 ? str(r[cLoc]) : '';
      const dealer = cDealer >= 0 ? str(r[cDealer]) : '';
      const fault = cFault >= 0 ? str(r[cFault]) : '';
      const waybill = cWaybill >= 0 ? str(r[cWaybill]) : '';

      const custKey = phoneNorm ?? `name:${name.toUpperCase()}`;
      const jobKey = imei ? `imei:${imei}` : `job:${custKey}:${when.toISOString().slice(0, 10)}:${fault}`;
      if (jobSeen.has(jobKey)) { rep.jobsSkipped++; continue; }
      jobSeen.add(jobKey);

      if (DRY) {
        if (!custByKey.has(custKey)) { custByKey.set(custKey, 'dry'); rep.customersCreated++; }
        if (imei && !devByImei.has(imei)) { devByImei.set(imei, 'dry'); rep.devicesCreated++; }
        else if (!imei) rep.devicesCreated++;
        rep.jobsCreated++;
        continue;
      }

      // customer
      let customerId = custByKey.get(custKey);
      if (!customerId) {
        const existing = phoneNorm
          ? await prisma.customer.findFirst({ where: { companyId: ctx.companyId, phoneNormalized: phoneNorm } })
          : await prisma.customer.findFirst({ where: { companyId: ctx.companyId, name, phone: null } });
        if (existing) customerId = existing.id;
        else {
          const c = await prisma.customer.create({
            data: {
              id: randomUUID(),
              companyId: ctx.companyId,
              name,
              phone: phoneRaw || null,
              phoneNormalized: phoneNorm,
              location: location || null,
              dealerName: dealer || null,
              isDealer: Boolean(dealer),
              preferredBranchId: dar.id,
              createdById: ctx.actorId,
              updatedById: ctx.actorId,
            },
          });
          customerId = c.id;
          rep.customersCreated++;
        }
        custByKey.set(custKey, customerId);
      }

      // device
      let deviceId = imei ? devByImei.get(imei) : undefined;
      if (!deviceId) {
        const existing = imei
          ? await prisma.device.findFirst({ where: { companyId: ctx.companyId, imeiSerial: imei } })
          : null;
        if (existing) deviceId = existing.id;
        else {
          const dev = await prisma.device.create({
            data: {
              id: randomUUID(),
              companyId: ctx.companyId,
              customerId,
              brand: 'Samsung',
              model: model || null,
              category,
              imeiSerial: imei,
              color: color || null,
              createdById: ctx.actorId,
              updatedById: ctx.actorId,
            },
          });
          deviceId = dev.id;
          rep.devicesCreated++;
        }
        if (imei) devByImei.set(imei, deviceId);
      }

      // job (deterministic H-prefixed number; skip if already imported)
      const jobNo = `HDAR-${hash([jobKey])}`;
      const exists = await prisma.job.findUnique({
        where: { companyId_jobNo: { companyId: ctx.companyId, jobNo } },
        select: { id: true },
      });
      if (exists) { rep.jobsSkipped++; continue; }
      await prisma.job.create({
        data: {
          id: randomUUID(),
          companyId: ctx.companyId,
          jobNo,
          branchId: dar.id,
          customerId,
          deviceId,
          bookedById: bookedBy,
          warrantyStatus: 'UNKNOWN',
          faultReported: fault || null,
          waybillNo: waybill || null,
          stateId: ctx.initialStateId,
          receivedAt: when,
          createdAt: when,
          createdById: ctx.actorId,
          updatedById: ctx.actorId,
        },
      });
      rep.jobsCreated++;
      if (processed >= LIMIT) break;
    }
    if (processed >= LIMIT) break;
  }
  return rep;
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const ctx = await loadCtx();
  console.log(`${DRY ? '[DRY RUN] ' : ''}import into "${COMPANY_NAME}" from ${DIR}`);
  console.log('─'.repeat(56));

  if (ONLY !== 'jobs') {
    const s = await importSales(ctx);
    console.log('SALES (invoices + payments)');
    console.log(`  invoices created:   ${s.invoicesCreated}`);
    console.log(`  invoices skipped:   ${s.invoicesSkipped} (already present)`);
    console.log(`  USD invoices:       ${s.usdInvoices}  ($${(Number(s.usdCents) / 100).toLocaleString()})`);
    console.log(`  TZS invoices:       ${s.tzsInvoices}  (TSh ${(Number(s.tzsSenti) / 100).toLocaleString()})`);
    console.log(`  rows skipped:       ${s.rowsSkipped} (no date)`);
    console.log(`  per branch:         ${[...s.perBranch].map(([b, n]) => `${b}=${n}`).join('  ')}`);
    console.log('─'.repeat(56));
  }
  if (ONLY !== 'sales') {
    const j = await importDarJobs(ctx);
    console.log('DAR JOB-INTAKE (customers + devices + jobs)');
    console.log(`  customers created:  ${j.customersCreated}`);
    console.log(`  devices created:    ${j.devicesCreated}`);
    console.log(`  jobs created:       ${j.jobsCreated}`);
    console.log(`  jobs skipped:       ${j.jobsSkipped} (dupe/present)`);
    console.log(`  rows skipped:       ${j.rowsSkipped} (no date)`);
    console.log('─'.repeat(56));
  }
  console.log(DRY ? '[DRY RUN] nothing written.' : 'Import complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
