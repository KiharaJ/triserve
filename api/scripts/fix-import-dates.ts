/**
 * One-off correction (maintenance): fix jobs whose received_at landed in the
 * FUTURE because the original import accepted a garbled source date (e.g.
 * "28.04.29" → 2029) which then poisoned the following carry-forward rows.
 *
 * Every affected job is an imei-keyed Dar-intake job, whose job_no
 * (HDAR-md5("imei:"+imei)) is independent of the date — so we re-parse the Dar
 * workbook with the FIXED parser (future dates rejected → carry-forward the last
 * valid date), rebuild job_no → corrected received date, and UPDATE the jobs
 * dated in the future. Idempotent; safe to re-run.
 *
 *   npm run fix:import-dates -- [--dir ~/Downloads] [--dry]
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { normalizeImeiSerial } from '../src/common/util/phone';

const prisma = new PrismaClient();
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry');
const DIR = (arg('dir') ?? join(homedir(), 'Downloads')).replace(/^~/, homedir());
const DAR_FILE = 'DAR DAILY  REPORTS DATA BASE NOV 25.xlsx';
const MAX_DATE = Date.now() + 86_400_000;

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}
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
function headerIndex(row: Array<unknown>): Map<string, number> {
  const m = new Map<string, number>();
  row.forEach((c, i) => {
    const k = str(c).toUpperCase();
    if (k && !m.has(k)) m.set(k, i);
  });
  return m;
}
function findCol(idx: Map<string, number>, needles: string[]): number {
  for (const [k, i] of idx) if (needles.some((n) => k.includes(n))) return i;
  return -1;
}
function jobNoFor(imei: string): string {
  return `HDAR-${createHash('md5').update(`imei:${imei}`).digest('hex').slice(0, 16)}`;
}

async function main(): Promise<void> {
  const wb = XLSX.read(readFileSync(join(DIR, DAR_FILE)), {
    type: 'buffer',
    cellDates: true,
  });
  const ordered = [...wb.SheetNames].sort((a, b) =>
    /RECEIVE/i.test(a) ? -1 : /RECEIVE/i.test(b) ? 1 : 0,
  );

  // Rebuild job_no → corrected received date (first sighting of each imei wins,
  // matching the importer's dedup order).
  const dateByJobNo = new Map<string, Date>();
  const seen = new Set<string>();
  for (const sheet of ordered) {
    const grid = XLSX.utils.sheet_to_json<Array<unknown>>(wb.Sheets[sheet], {
      header: 1, defval: null, blankrows: false,
    });
    const h = grid.findIndex((r) => (r ?? []).some((c) => /CUSTOMER NAME/i.test(str(c))));
    if (h < 0) continue;
    const idx = headerIndex(grid[h]);
    const cDate = findCol(idx, ['DATE']);
    const cName = findCol(idx, ['CUSTOMER NAME']);
    const cImei = findCol(idx, ['IMEI']);
    const monthFallback = sheetMonthDate(sheet);
    let lastDate: Date | null = null;
    for (const r of grid.slice(h + 1)) {
      const name = str(r[cName]);
      if (!name || /CUSTOMER NAME/i.test(name)) continue;
      const d = parseDate(r[cDate]);
      if (d) lastDate = d;
      const when = d ?? lastDate ?? monthFallback;
      if (!when) continue;
      const imei = cImei >= 0 ? normalizeImeiSerial(str(r[cImei])) : null;
      const jobKey = imei ? `imei:${imei}` : `row:${name}:${when.toISOString().slice(0, 10)}`;
      if (seen.has(jobKey)) continue;
      seen.add(jobKey);
      if (imei) dateByJobNo.set(jobNoFor(imei), when);
    }
  }

  // Jobs currently dated in the future.
  const future = await prisma.job.findMany({
    where: { receivedAt: { gt: new Date() } },
    select: { id: true, jobNo: true, receivedAt: true },
  });
  console.log(`${DRY ? '[DRY RUN] ' : ''}future-dated jobs: ${future.length}`);

  let fixed = 0;
  let unmatched = 0;
  for (const j of future) {
    const corrected = dateByJobNo.get(j.jobNo);
    if (!corrected) {
      unmatched++;
      console.log(`  unmatched ${j.jobNo} (${j.receivedAt.toISOString().slice(0, 10)})`);
      continue;
    }
    console.log(
      `  ${j.jobNo}: ${j.receivedAt.toISOString().slice(0, 10)} → ${corrected
        .toISOString()
        .slice(0, 10)}`,
    );
    if (!DRY) {
      await prisma.job.update({
        where: { id: j.id },
        data: { receivedAt: corrected, createdAt: corrected },
      });
    }
    fixed++;
  }
  console.log('─'.repeat(48));
  console.log(`${DRY ? 'would fix' : 'fixed'}: ${fixed} | unmatched: ${unmatched}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
