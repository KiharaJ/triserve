/**
 * Inventory migration importer (Task 2.10, DESIGN.md §10 / §4.4b).
 *
 * Loads the REAL parts catalogue + opening stock from the spreadsheets (export
 * each sheet to CSV first). Idempotent AND non-destructive, like the seed:
 * parts/suppliers are upserted; opening stock quantities are set only when the
 * inventory row is first created (re-running never resets stock that has since
 * moved through the app), and each opening RECEIPT ledger row is written once.
 *
 *   npm run import:inventory -- --parts parts.csv [--stock stock.csv] [--dry]
 *                              [--company "Samsung ASC Group"]
 *
 *   --dry    parse + validate + report, write NOTHING.
 *
 * ── parts.csv columns (header row required) ────────────────────────────────
 *   part_number          e.g. GH82-33385A                (required, unique)
 *   description          e.g. "S928B LCD OLED"           (required)
 *   category             HHP | CE | AC | REF | OTHER     (mapped, default OTHER)
 *   unit_cost_usd        landed cost in WHOLE USD dollars (→ stored as cents)
 *   sell_price_tzs       OW price in WHOLE TZS shillings  (→ stored as senti)
 *   reorder_level        integer                          (default 0)
 *   preferred_supplier   supplier name                    (auto-created if new)
 *   is_serialized        yes/no/true/false/1/0            (default no)
 *   compatible_models    comma-separated inside a quoted field, e.g. "S24,S24U"
 *
 * ── stock.csv columns (optional; header row required) ──────────────────────
 *   part_number          must exist (in parts.csv or already loaded)
 *   branch_code          e.g. DAR                         (must exist)
 *   qty_on_hand          integer opening quantity
 *   bin_location         e.g. A3                          (optional)
 *
 * Money is entered in WHOLE units and stored as minor units (×100), matching
 * the seed. Amounts already in minor units? Divide by 100 in your export first.
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

// ─── args ──────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const DRY = process.argv.includes('--dry');
const PARTS_FILE = arg('parts');
const STOCK_FILE = arg('stock');
const COMPANY_NAME = arg('company') ?? 'Samsung ASC Group';

// ─── minimal CSV parser (RFC-4180-ish: quoted fields, "" escapes, CRLF) ──────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  return rows;
}

/** Parse a CSV file into an array of {header: value} objects (headers lower-cased). */
function readRecords(file: string): Record<string, string>[] {
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = (r[i] ?? '').trim()));
    return rec;
  });
}

// ─── field coercion ──────────────────────────────────────────────────────────
const CATEGORIES = new Set(['HHP', 'CE', 'AC', 'REF', 'OTHER']);
function toCategory(v: string): 'HHP' | 'CE' | 'AC' | 'REF' | 'OTHER' {
  const u = v.trim().toUpperCase();
  return CATEGORIES.has(u) ? (u as 'HHP') : 'OTHER';
}
function toBool(v: string): boolean {
  return ['yes', 'true', '1', 'y'].includes(v.trim().toLowerCase());
}
/** Whole-unit money string → minor-unit BigInt (×100); blank → null. */
function toMinor(v: string): bigint | null {
  const t = v.replace(/,/g, '').trim();
  if (t === '') return null;
  if (!/^\d+$/.test(t)) throw new Error(`not a whole number: "${v}"`);
  return BigInt(t) * 100n;
}
function toInt(v: string, dflt = 0): number {
  const t = v.replace(/,/g, '').trim();
  if (t === '') return dflt;
  const n = Number(t);
  if (!Number.isInteger(n)) throw new Error(`not an integer: "${v}"`);
  return n;
}

interface Report {
  suppliersCreated: number;
  partsCreated: number;
  partsUpdated: number;
  inventoryCreated: number;
  openingMovements: number;
  skipped: string[];
}

async function main(): Promise<void> {
  if (!PARTS_FILE) {
    throw new Error('--parts <file.csv> is required');
  }
  const company = await prisma.company.findFirst({
    where: { name: COMPANY_NAME },
  });
  if (!company) throw new Error(`Company not found: "${COMPANY_NAME}"`);
  const admin = await prisma.user.findFirst({
    where: { companyId: company.id, role: 'SUPER_ADMIN' },
    orderBy: { createdAt: 'asc' },
  });
  const actorId = admin?.id ?? null;

  console.log(
    `${DRY ? '[DRY RUN] ' : ''}import into "${company.name}" (${company.id})`,
  );

  const report: Report = {
    suppliersCreated: 0,
    partsCreated: 0,
    partsUpdated: 0,
    inventoryCreated: 0,
    openingMovements: 0,
    skipped: [],
  };

  // ── suppliers (resolve/create by name from the parts file) ────────────────
  const partRecords = readRecords(PARTS_FILE);
  const supplierIdByName = new Map<string, string>();
  const supplierNames = new Set(
    partRecords.map((r) => r.preferred_supplier).filter(Boolean),
  );
  for (const name of supplierNames) {
    const existing = await prisma.supplier.findFirst({
      where: { companyId: company.id, name },
    });
    if (existing) {
      supplierIdByName.set(name, existing.id);
      continue;
    }
    if (DRY) {
      supplierIdByName.set(name, `dry-${randomUUID()}`);
      report.suppliersCreated++;
      continue;
    }
    const created = await prisma.supplier.create({
      data: {
        id: randomUUID(),
        companyId: company.id,
        name,
        defaultCurrency: 'USD',
        createdById: actorId,
        updatedById: actorId,
      },
    });
    supplierIdByName.set(name, created.id);
    report.suppliersCreated++;
  }

  // ── parts (upsert by company + part_number) ───────────────────────────────
  const partIdByNumber = new Map<string, string>();
  // reorder_level is per-part in the CSV but lives on the per-branch inventory
  // rows — carry it to the stock loop below.
  const reorderByPartNumber = new Map<string, number>();
  for (const [idx, r] of partRecords.entries()) {
    const partNumber = r.part_number;
    if (!partNumber || !r.description) {
      report.skipped.push(`parts row ${idx + 2}: missing part_number/description`);
      continue;
    }
    let unitCost: bigint | null;
    let sellPrice: bigint | null;
    let reorder: number;
    try {
      unitCost = toMinor(r.unit_cost_usd ?? '');
      sellPrice = toMinor(r.sell_price_tzs ?? '');
      reorder = toInt(r.reorder_level ?? '', 0);
    } catch (e) {
      report.skipped.push(`parts row ${idx + 2} (${partNumber}): ${String(e)}`);
      continue;
    }
    reorderByPartNumber.set(partNumber, reorder);
    const models = (r.compatible_models ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const supplierId = r.preferred_supplier
      ? (supplierIdByName.get(r.preferred_supplier) ?? null)
      : null;

    const existing = await prisma.part.findFirst({
      where: { companyId: company.id, partNumber },
    });
    if (DRY) {
      partIdByNumber.set(partNumber, existing?.id ?? `dry-${randomUUID()}`);
      if (existing) report.partsUpdated++;
      else report.partsCreated++;
      continue;
    }
    const data = {
      description: r.description,
      category: toCategory(r.category ?? ''),
      unitCostUsd: unitCost,
      sellPriceTzs: sellPrice,
      compatibleModels: models.length ? models : undefined,
      isSerialized: toBool(r.is_serialized ?? ''),
      preferredSupplierId: supplierId,
    };
    const part = await prisma.part.upsert({
      where: {
        companyId_partNumber: { companyId: company.id, partNumber },
      },
      update: { ...data, active: true, updatedById: actorId },
      create: {
        id: randomUUID(),
        companyId: company.id,
        partNumber,
        ...data,
        createdById: actorId,
        updatedById: actorId,
      },
    });
    partIdByNumber.set(partNumber, part.id);
    if (existing) report.partsUpdated++;
      else report.partsCreated++;
  }

  // ── opening stock (optional) ──────────────────────────────────────────────
  if (STOCK_FILE) {
    const branchByCode = new Map(
      (
        await prisma.branch.findMany({ where: { companyId: company.id } })
      ).map((b) => [b.code.toUpperCase(), b.id]),
    );
    for (const [idx, r] of readRecords(STOCK_FILE).entries()) {
      const line = `stock row ${idx + 2}`;
      const branchId = branchByCode.get((r.branch_code ?? '').toUpperCase());
      const partId = partIdByNumber.get(r.part_number ?? '');
      if (!branchId) {
        report.skipped.push(`${line}: unknown branch "${r.branch_code}"`);
        continue;
      }
      if (!partId) {
        report.skipped.push(`${line}: unknown part "${r.part_number}"`);
        continue;
      }
      let qty: number;
      try {
        qty = toInt(r.qty_on_hand ?? '', 0);
      } catch (e) {
        report.skipped.push(`${line}: ${String(e)}`);
        continue;
      }
      if (qty <= 0) continue;

      const existingInv = await prisma.inventory.findFirst({
        where: { branchId, partId },
      });
      if (DRY) {
        // Opening stock is set only when the row is first created (see below).
        if (!existingInv) {
          report.inventoryCreated++;
          report.openingMovements++;
        }
        continue;
      }
      if (!existingInv) {
        await prisma.inventory.create({
          data: {
            id: randomUUID(),
            companyId: company.id,
            branchId,
            partId,
            qtyOnHand: qty,
            reorderLevel: reorderByPartNumber.get(r.part_number) ?? 0,
            binLocation: r.bin_location || null,
            createdById: actorId,
            updatedById: actorId,
          },
        });
        report.inventoryCreated++;
      } else if (r.bin_location) {
        await prisma.inventory.update({
          where: { id: existingInv.id },
          data: { binLocation: r.bin_location, updatedById: actorId },
        });
      }
      const openingExists = await prisma.stockMovement.findFirst({
        where: { branchId, partId, reason: 'Opening stock (import)' },
      });
      if (!openingExists && !existingInv) {
        const cost = (await prisma.part.findUniqueOrThrow({ where: { id: partId } }))
          .unitCostUsd;
        await prisma.stockMovement.create({
          data: {
            id: randomUUID(),
            companyId: company.id,
            branchId,
            partId,
            movementType: 'RECEIPT',
            qty,
            reason: 'Opening stock (import)',
            unitCost: cost,
            costCurrency: cost !== null ? 'USD' : null,
            movedById: actorId ?? randomUUID(),
          },
        });
        report.openingMovements++;
      }
    }
  }

  console.log('─'.repeat(48));
  console.log(`suppliers created:   ${report.suppliersCreated}`);
  console.log(`parts created:       ${report.partsCreated}`);
  console.log(`parts updated:       ${report.partsUpdated}`);
  console.log(`inventory rows new:  ${report.inventoryCreated}`);
  console.log(`opening movements:   ${report.openingMovements}`);
  if (report.skipped.length) {
    console.log(`skipped (${report.skipped.length}):`);
    for (const s of report.skipped.slice(0, 50)) console.log(`  - ${s}`);
    if (report.skipped.length > 50) {
      console.log(`  … and ${report.skipped.length - 50} more`);
    }
  }
  console.log(DRY ? '[DRY RUN] nothing written.' : 'Import complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
