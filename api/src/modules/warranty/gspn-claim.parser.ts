import type { ServiceType, WarrantyStatus } from '@prisma/client';
import {
  buildFieldMap,
  hasMarker,
  parseGspnCode,
  parseGspnDate,
  parseGspnPhone,
  parseUsdToMinor,
  type GspnCode,
  type PdfRow,
} from '../jobs/gspn-pdf';

/**
 * Parser for Samsung GSPN "Warranty Claim Detail" PDFs (§4.7).
 *
 * The claim is the payout side of a repair: Samsung's three reference
 * numbers, the settled cost split, the diagnosis codes and the parts they
 * agreed to reimburse. Everything here maps onto `warranty_claims` and
 * `warranty_claim_lines`.
 *
 * Unlike the job card, this document has no check boxes — every field it
 * carries is real text, so a claim CAN be read end to end. It is still
 * returned as a DRAFT: the claim it belongs to has to be matched to one of
 * our jobs, and that is a judgement we leave to a human.
 *
 * Money is returned as USD MINOR units (cents) in strings, matching how
 * `warranty_claims` stores and serialises it.
 */

export interface ParsedClaimLine {
  line_no: number;
  part_no: string;
  description: string | null;
  location: string | null;
  qty: number;
  /** USD minor units. */
  unit_price_usd: string | null;
  amount_usd: string | null;
  invoice_no: string | null;
  part_serial_no: string | null;
}

export interface ParsedClaim {
  /** GSPN's "ASC Claim No" — our `claim_no`. */
  claim_no: string | null;
  samsung_ref_no: string | null;
  ticket_no: string | null;
  /** Verbatim, e.g. `20-Data closed`. */
  gspn_status: string | null;
  service_type: ServiceType | null;
  customer_name: string | null;
  phone: string | null;
  model: string | null;
  serial: string | null;
  imei_masked: string | null;
  purchase_date: string | null;
  repair_received_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  /** `In Warranty` → IW, `Out of Warranty` → OW. */
  warranty_status: WarrantyStatus | null;
  condition_code: GspnCode | null;
  symptom_code: GspnCode | null;
  defect_code: GspnCode | null;
  defect_type: GspnCode | null;
  repair_code: GspnCode | null;
  defect_description: string | null;
  repair_description: string | null;
  /** All USD minor units. */
  claim_amount_usd: string | null;
  labour_amount_usd: string | null;
  parts_amount_usd: string | null;
  shipping_amount_usd: string | null;
  tax_amount_usd: string | null;
  lines: ParsedClaimLine[];
  warnings: string[];
}

/** Labels printed on the claim; also the value terminators (see gspn-pdf). */
export const CLAIM_LABELS: readonly string[] = [
  'Account',
  'Partner',
  'Samsung Ref. No',
  'ASC Claim No',
  'Service Type',
  'Status',
  'Ticket No',
  'Tracking Type',
  'Customer Name',
  'Address',
  'City',
  'State/Region',
  'Zip Code',
  'Phone',
  'Model Name',
  'Serial No',
  'CRT/ESM/IMEI',
  'Defect Type',
  'Purchase Date',
  'Repair Received Date',
  'Completed Date',
  'Delivered Date',
  'Condition Code',
  'Symptom Code',
  'Defect Code',
  'Repair Code',
  'Defect Description',
  'Repair Description',
  'In/Out Warranty',
  'Total Amount',
  'Remarks',
  'Labour Cost',
  'Part Cost',
  'Shipping/Other',
  'Tax',
];

const SERVICE_TYPE_BY_LABEL: Record<string, ServiceType> = {
  'carry in': 'CARRY_IN',
  'pick up service': 'PICKUP',
  'pickup service': 'PICKUP',
  'in home': 'IN_HOME',
  'initial installation': 'INITIAL_INSTALL',
  inspection: 'INSPECTION',
  'insurance service': 'INSURANCE',
  'product return': 'PRODUCT_RETURN',
  'return handling': 'RETURN_HANDLING',
  'stock repair': 'STOCK_REPAIR',
  'accidental damage handling': 'ADH',
};

/** The page title — our guard against someone uploading a different PDF. */
export const CLAIM_MARKER = 'Warranty Claim Detail';

/** Column header → the key we file its cell under. */
const PART_COLUMNS: ReadonlyArray<{ header: string; key: string }> = [
  { header: 'No', key: 'no' },
  { header: 'Location', key: 'location' },
  { header: 'Part No.', key: 'part_no' },
  { header: 'Description Spceification', key: 'description' }, // GSPN's typo
  { header: 'Qty', key: 'qty' },
  { header: 'Amount', key: 'amount' },
  { header: 'Invoice No', key: 'invoice_no' },
];

/**
 * Parts table → line items.
 *
 * Two things make this harder than the label/value pairs above:
 *
 *  1. The header spans three baselines ("Unit"/"Price" and "Parts"/"Serial
 *     No" wrap), so column x positions are collected from the row carrying
 *     `Part No.` and the stragglers are matched by nearest column.
 *  2. A cell WRAPS onto a second baseline: part `GH81-26450A` prints as
 *     `GH81-` then `26450A`, and the row number sits on the lower line
 *     because it is vertically centred. So rows within ~12pt are one item.
 *
 * Wrapped fragments are joined with NO separator: GSPN wraps on character
 * count, not word boundaries (`GH81-` + `26450A`, `…;SM-` + `A065`), so
 * inserting a space would corrupt the part number — the one field here that
 * is an identifier rather than prose.
 */
export function parsePartLines(rows: PdfRow[]): ParsedClaimLine[] {
  const headerIdx = rows.findIndex((r) =>
    r.segments.some((s) => s.text.trim() === 'Part No.'),
  );
  if (headerIdx === -1) return [];

  const header = rows[headerIdx];
  const columns: Array<{ key: string; x: number }> = [];
  for (const seg of header.segments) {
    const col = PART_COLUMNS.find((c) => c.header === seg.text.trim());
    if (col) columns.push({ key: col.key, x: seg.x });
  }
  // "Unit Price" and "Parts Serial No" wrap across the header rows above and
  // below; take their x from the neighbouring rows.
  for (const near of [rows[headerIdx - 1], rows[headerIdx + 1]]) {
    for (const seg of near?.segments ?? []) {
      const t = seg.text.trim();
      if (t === 'Unit' || t === 'Price') {
        if (!columns.some((c) => c.key === 'unit_price')) {
          columns.push({ key: 'unit_price', x: seg.x });
        }
      }
      if (t === 'Serial No') {
        if (!columns.some((c) => c.key === 'part_serial_no')) {
          columns.push({ key: 'part_serial_no', x: seg.x });
        }
      }
    }
  }
  if (columns.length === 0) return [];
  columns.sort((a, b) => a.x - b.x);

  const columnFor = (x: number): string => {
    let best = columns[0];
    for (const c of columns) {
      if (Math.abs(c.x - x) < Math.abs(best.x - x)) best = c;
    }
    return best.key;
  };

  // Body rows: below the header, on the same page, above the page footer.
  const body = rows
    .slice(headerIdx + 1)
    .filter((r) => r.page === header.page && r.y > 60);

  // Group wrapped baselines into one item (~9pt apart within a cell).
  const groups: PdfRow[][] = [];
  for (const r of body) {
    const last = groups[groups.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && Math.abs(prev.y - r.y) <= 12) last.push(r);
    else groups.push([r]);
  }

  const lines: ParsedClaimLine[] = [];
  for (const group of groups) {
    const cells = new Map<string, string>();
    for (const r of group) {
      for (const seg of [...r.segments].sort((a, b) => a.x - b.x)) {
        const key = columnFor(seg.x);
        // No separator — GSPN wraps mid-token (see the doc comment).
        cells.set(key, (cells.get(key) ?? '') + seg.text.trim());
      }
    }
    const partNo = cells.get('part_no')?.trim();
    // A group with no part number is a stray footer line, not an item.
    if (!partNo) continue;
    lines.push({
      line_no: Number(cells.get('no') ?? lines.length + 1) || lines.length + 1,
      part_no: partNo,
      description: cells.get('description')?.trim() || null,
      location: cells.get('location')?.trim() || null,
      // GSPN zero-pads quantities (`001`).
      qty: Number(cells.get('qty') ?? '1') || 1,
      unit_price_usd: parseUsdToMinor(cells.get('unit_price') ?? null),
      amount_usd: parseUsdToMinor(cells.get('amount') ?? null),
      invoice_no: cells.get('invoice_no')?.trim() || null,
      part_serial_no: cells.get('part_serial_no')?.trim() || null,
    });
  }
  return lines;
}

/** Pure rows → claim draft. Never throws; unreadable fields become null. */
export function parseClaim(rows: PdfRow[]): ParsedClaim {
  const f = buildFieldMap(rows, CLAIM_LABELS);
  const get = (label: string): string | null => f.get(label)?.trim() || null;

  const serviceTypeRaw = get('Service Type');
  const serviceType = serviceTypeRaw
    ? (SERVICE_TYPE_BY_LABEL[serviceTypeRaw.toLowerCase().trim()] ?? null)
    : null;

  const warrantyRaw = get('In/Out Warranty')?.toLowerCase() ?? null;
  const warrantyStatus: WarrantyStatus | null = warrantyRaw
    ? warrantyRaw.startsWith('in')
      ? 'IW'
      : warrantyRaw.startsWith('out')
        ? 'OW'
        : null
    : null;

  // `10.95 / 0.00` — shipping and "other" share one cell; we bank shipping.
  const shippingCell = get('Shipping/Other');
  const shipping = parseUsdToMinor(shippingCell?.split('/')[0] ?? null);

  const total = parseUsdToMinor(get('Total Amount'));
  const labour = parseUsdToMinor(get('Labour Cost'));
  const parts = parseUsdToMinor(get('Part Cost'));
  const tax = parseUsdToMinor(get('Tax'));

  const lines = parsePartLines(rows);
  const warnings: string[] = [];

  if (serviceTypeRaw && !serviceType) {
    warnings.push(`Unrecognised service type "${serviceTypeRaw}".`);
  }
  if (warrantyRaw && !warrantyStatus) {
    warnings.push(`Unrecognised warranty status "${get('In/Out Warranty')}".`);
  }
  // The components must reconcile to the printed total. If they do not, the
  // PDF was read wrong somewhere — say so rather than bank a wrong figure.
  const componentSum = [labour, parts, shipping, tax].reduce(
    (acc, v) => acc + BigInt(v ?? '0'),
    0n,
  );
  if (total !== null && componentSum !== BigInt(total)) {
    warnings.push(
      `Labour + parts + shipping + tax (${componentSum}) does not match the printed total (${total}) — check the claim before saving.`,
    );
  }
  if (lines.length === 0) {
    warnings.push('No part lines were read from the claim.');
  }

  return {
    claim_no: get('ASC Claim No'),
    samsung_ref_no: get('Samsung Ref. No'),
    ticket_no: get('Ticket No'),
    gspn_status: get('Status'),
    service_type: serviceType,
    customer_name: get('Customer Name'),
    phone: parseGspnPhone(get('Phone')),
    model: get('Model Name'),
    serial: get('Serial No'),
    imei_masked: get('CRT/ESM/IMEI'),
    purchase_date: parseGspnDate(get('Purchase Date')),
    repair_received_at: parseGspnDate(get('Repair Received Date')),
    completed_at: parseGspnDate(get('Completed Date')),
    delivered_at: parseGspnDate(get('Delivered Date')),
    warranty_status: warrantyStatus,
    condition_code: parseGspnCode(get('Condition Code')),
    symptom_code: parseGspnCode(get('Symptom Code')),
    defect_code: parseGspnCode(get('Defect Code')),
    defect_type: parseGspnCode(get('Defect Type')),
    repair_code: parseGspnCode(get('Repair Code')),
    defect_description: get('Defect Description'),
    repair_description: get('Repair Description'),
    claim_amount_usd: total,
    labour_amount_usd: labour,
    parts_amount_usd: parts,
    shipping_amount_usd: shipping,
    tax_amount_usd: tax,
    lines,
    warnings,
  };
}

/** True when the extracted rows look like a GSPN Warranty Claim Detail. */
export function looksLikeClaim(rows: PdfRow[]): boolean {
  return hasMarker(rows, CLAIM_MARKER);
}
