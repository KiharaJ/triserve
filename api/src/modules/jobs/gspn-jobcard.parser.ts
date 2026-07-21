import type { ServiceType } from '@prisma/client';

/**
 * Parser for Samsung GSPN "Service Order Sheet" job-card PDFs (§4.7).
 *
 * GSPN has no CSV export for service orders, so the printed job card is the
 * only machine-readable artefact available. The PDFs are digitally generated
 * (Arial only, no scan), so there is a real text layer — no OCR involved.
 *
 * Split in two on purpose:
 *   - {@link extractRows} touches pdfjs and is the untestable-in-CI half;
 *   - {@link parseJobCard} is a pure rows→fields mapping and holds ALL the
 *     logic worth testing, so the suite needs no real customer PDF committed
 *     to the repo (a job card carries a name, phone and home address).
 *
 * WHAT THIS DELIBERATELY DOES NOT PARSE — the warranty check box.
 * The card prints all four options as plain text:
 *     Full Warranty / Labor only / Parts only / Out of warranty
 * and the tick is a VECTOR PATH, not a character — the file embeds only
 * Arial and Arial-Bold, no symbol font, so nothing in the text layer says
 * which box is marked. That field decides `coverage`, i.e. who pays. Pixel-
 * sampling the box positions would work until Samsung nudges the template,
 * and would then be silently wrong about money. So coverage is always left
 * for a human, and {@link ParsedJobCard.warnings} says so on every import.
 */

/** One text run with its horizontal position, within a visual row. */
export interface PdfSegment {
  x: number;
  text: string;
}

/**
 * Text runs sharing a baseline on ONE page, ordered left to right.
 *
 * `page` is part of a row's identity, not decoration: page 2 of the card is
 * the terms and conditions, and its lines sit at the same y values as the
 * data table on page 1. Grouping on y alone splices T&C prose into the
 * middle of the customer's name and address.
 */
export interface PdfRow {
  page: number;
  y: number;
  segments: PdfSegment[];
}

export interface ParsedJobCard {
  so_number: string | null;
  customer_name: string | null;
  phone: string | null;
  address: string | null;
  model: string | null;
  serial: string | null;
  /** GSPN masks all but the last digits (`********7260294`) — match on serial. */
  imei_masked: string | null;
  /** ISO `yyyy-mm-dd`. */
  purchase_date: string | null;
  service_type: ServiceType | null;
  accessories_held: string | null;
  fault_reported: string | null;
  repair_description: string | null;
  /** ISO 8601 instant. */
  appointment_at: string | null;
  /** Always null — see the file header. The advisor must rule the warranty. */
  coverage: null;
  /** Things the operator must know before trusting this draft. */
  warnings: string[];
}

/**
 * Every label printed on the card. Used as VALUE TERMINATORS as much as
 * keys: the card is two-column, so "Model Name │ SM-A065F │ Serial No (
 * IMEI ) │ R83L…" is one row, and without knowing that `Serial No ( IMEI )`
 * is a label the model would swallow the rest of the line.
 *
 * `Address:` (service centre, header) and `Address` (the customer's) are
 * distinct entries on purpose — they differ only by the colon.
 */
const LABELS: readonly string[] = [
  'Service Order No :',
  'Customer No :',
  'CP/Dealer Ref. No :',
  'Service Center:',
  'Address:',
  'Contact Center:',
  'Customer Name',
  'Request Date',
  'Address',
  'Appointment Date',
  'Engineer Code',
  'Telephone',
  'Fax',
  'Model Name',
  'Serial No ( IMEI )',
  'Purchase Date',
  'Service Type',
  'Warranty Status',
  'Full Warranty',
  'Labor only',
  'Parts only',
  'Out of warranty',
  'Repair Received',
  'Repair Completed',
  'Goods Delivered',
  'Return by / Date',
  'Accessory',
  'Defect Description',
  'Repair Description',
  'Remark',
];

/** Longest-first so `Address:` wins over `Address` on the header row. */
const LABELS_BY_LENGTH = [...LABELS].sort((a, b) => b.length - a.length);

/** Printed service types → our enum. */
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
export const JOBCARD_MARKER = 'Service Order Sheet';

/**
 * GSPN prints US-order `MM.DD.YYYY`. Confirmed by values that cannot be
 * day-first: a claim's `05.13.2026` has no 13th month. Returns ISO
 * `yyyy-mm-dd`, or null when the text is not a date in that shape.
 */
export function parseGspnDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = /(\d{2})\.(\d{2})\.(\d{4})/.exec(raw);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}`;
}

/** `07.15.2026 (09:29:12)` → an ISO instant; date-only input still works. */
export function parseGspnDateTime(raw: string | null): string | null {
  const date = parseGspnDate(raw);
  if (!date) return null;
  const t = /\((\d{2}):(\d{2}):(\d{2})\)/.exec(raw ?? '');
  return t ? `${date}T${t[1]}:${t[2]}:${t[3]}.000Z` : `${date}T00:00:00.000Z`;
}

/**
 * `[Home]0713951123[Office]0713951123` → `0713951123`. GSPN concatenates
 * every number it holds into one cell with bracketed tags; the first is the
 * one to reach the customer on.
 */
export function parseGspnPhone(raw: string | null): string | null {
  if (!raw) return null;
  const tagged = /\[[^\]]*\]\s*([+\d][\d\s-]*)/.exec(raw);
  const value = (tagged ? tagged[1] : raw).trim();
  return value.length > 0 ? value : null;
}

/** Match a label at the start of a segment; returns it and the inline rest. */
function matchLabel(text: string): { label: string; rest: string } | null {
  for (const label of LABELS_BY_LENGTH) {
    if (text === label) return { label, rest: '' };
    if (text.startsWith(label)) {
      const rest = text.slice(label.length).trim();
      // `Service Order No : 4295708333` arrives as ONE run, but `Addressable`
      // must not match `Address` — require a separator.
      if (rest === '' || /^[:\s]/.test(text.slice(label.length))) {
        return { label, rest: rest.replace(/^:\s*/, '') };
      }
    }
  }
  return null;
}

/**
 * Collapse rows into `label → value`. Within a row, everything after a label
 * belongs to it until the next label starts.
 */
export function buildFieldMap(rows: PdfRow[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (const row of rows) {
    let current: string | null = null;
    const parts: string[] = [];
    const flush = (): void => {
      if (current && parts.length > 0 && !fields.has(current)) {
        fields.set(current, parts.join(' ').trim());
      }
      parts.length = 0;
    };
    for (const seg of [...row.segments].sort((a, b) => a.x - b.x)) {
      const text = seg.text.trim();
      if (!text) continue;
      const hit = matchLabel(text);
      if (hit) {
        flush();
        current = hit.label;
        if (hit.rest) parts.push(hit.rest);
      } else if (current) {
        parts.push(text);
      }
    }
    flush();
  }
  return fields;
}

/** Pure rows → draft mapping. Never throws; unrecognised fields become null. */
export function parseJobCard(rows: PdfRow[]): ParsedJobCard {
  const f = buildFieldMap(rows);
  const get = (label: string): string | null => f.get(label)?.trim() || null;

  const serialCell = get('Serial No ( IMEI )');
  // `R83L40GG4XW ( ********7260294 )` — serial first, masked IMEI in brackets.
  const serialMatch = /^(\S+)(?:\s*\(\s*([^)]*?)\s*\))?/.exec(serialCell ?? '');

  const serviceTypeRaw = get('Service Type');
  const serviceType = serviceTypeRaw
    ? (SERVICE_TYPE_BY_LABEL[serviceTypeRaw.toLowerCase().trim()] ?? null)
    : null;

  const warnings: string[] = [
    'Warranty coverage was not read from the PDF — the tick box is a drawn mark, not text. Set it before creating the job.',
  ];
  if (serviceTypeRaw && !serviceType) {
    warnings.push(
      `Unrecognised service type "${serviceTypeRaw}" — set it manually.`,
    );
  }
  const imeiMasked = serialMatch?.[2] ?? null;
  if (imeiMasked?.includes('*')) {
    warnings.push(
      'GSPN masks the IMEI on job cards; matched on serial number instead.',
    );
  }

  return {
    so_number: get('Service Order No :'),
    customer_name: get('Customer Name'),
    phone: parseGspnPhone(get('Telephone')),
    address: get('Address'),
    model: get('Model Name'),
    serial: serialMatch?.[1] ?? null,
    imei_masked: imeiMasked,
    purchase_date: parseGspnDate(get('Purchase Date')),
    service_type: serviceType,
    accessories_held: get('Accessory'),
    fault_reported: get('Defect Description'),
    repair_description: get('Repair Description'),
    appointment_at: parseGspnDateTime(get('Appointment Date')),
    coverage: null,
    warnings,
  };
}

/**
 * PDF bytes → visual rows, via pdfjs.
 *
 * Text runs are grouped by baseline (±3pt, since a row's runs are not always
 * pixel-identical) and ordered by x, which reconstructs the card's two-column
 * table. Loaded through a dynamic import because pdfjs ships ESM only.
 */
export async function extractRows(data: Uint8Array): Promise<PdfRow[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    // A job card is a static form: no scripts, no external fetches.
    isEvalSupported: false,
  }).promise;
  try {
    const rows: PdfRow[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const pageRows: PdfRow[] = [];
      // pdfjs types `items` as a union including marked-content markers that
      // carry no text; narrow to the shape we actually read rather than
      // letting `any` through.
      const items = content.items as Array<{
        str?: unknown;
        transform?: unknown;
      }>;
      for (const item of items) {
        const text = typeof item.str === 'string' ? item.str : '';
        if (!text.trim()) continue;
        // transform = [a, b, c, d, e, f]; e/f are the translation (x, y).
        const transform = item.transform;
        if (!Array.isArray(transform) || transform.length < 6) continue;
        const x = Number(transform[4]);
        const y = Math.round(Number(transform[5]));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        // Scoped to THIS page's rows — see the PdfRow doc comment.
        const row = pageRows.find((r) => Math.abs(r.y - y) <= 3);
        if (row) row.segments.push({ x, text });
        else pageRows.push({ page: p, y, segments: [{ x, text }] });
      }
      // Top of the page first, matching reading order.
      pageRows.sort((a, b) => b.y - a.y);
      rows.push(...pageRows);
      page.cleanup();
    }
    return rows;
  } finally {
    await doc.destroy();
  }
}

/** True when the extracted rows look like a GSPN Service Order Sheet. */
export function looksLikeJobCard(rows: PdfRow[]): boolean {
  return rows.some((r) =>
    r.segments.some((s) => s.text.includes(JOBCARD_MARKER)),
  );
}
