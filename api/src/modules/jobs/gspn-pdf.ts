/**
 * Shared primitives for reading Samsung GSPN PDFs (§4.7).
 *
 * GSPN exports no CSV for service orders or claims, so its printed PDFs are
 * the only machine-readable artefacts. They are digitally generated (Arial
 * only, no scan), so there is a real text layer — no OCR involved.
 *
 * Both documents are two-column label/value tables, so extraction is
 * POSITIONAL: text runs are grouped into rows by baseline and ordered by x,
 * which reconstructs the table. Labels double as value terminators — without
 * knowing that `Serial No` is a label, `Model Name` would swallow the rest of
 * its row.
 */

/** One text run with its horizontal position, within a visual row. */
export interface PdfSegment {
  x: number;
  text: string;
}

/**
 * Text runs sharing a baseline on ONE page, ordered left to right.
 *
 * `page` is part of a row's identity, not decoration: page 2 of a job card is
 * the terms and conditions, and its lines sit at the same y values as the
 * data table on page 1. Grouping on y alone splices T&C prose into the middle
 * of the customer's name and address.
 */
export interface PdfRow {
  page: number;
  y: number;
  segments: PdfSegment[];
}

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

/**
 * `40.30` → `"4030"` — USD MINOR units as a string, matching how every other
 * money value crosses our wire. Parsed from text, so it never goes through a
 * float: `40.30 * 100` is `4029.999…` in binary floating point.
 */
export function parseUsdToMinor(raw: string | null): string | null {
  if (!raw) return null;
  const m = /(-?)(\d+)(?:\.(\d{1,2}))?/.exec(raw.replace(/,/g, ''));
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const cents = `${whole}${frac.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return `${sign}${cents}`;
}

/**
 * `T83 - USB connectivity problem` → `{ code: 'T83', label: 'USB …' }`.
 * A cell with no ` - ` separator (the claim's `Defect Type: Level 2 Service`)
 * yields a label and a null code, rather than being dropped.
 */
export interface GspnCode {
  code: string | null;
  label: string;
}

export function parseGspnCode(raw: string | null): GspnCode | null {
  if (!raw?.trim()) return null;
  const m = /^(\S+)\s+-\s+(.*)$/.exec(raw.trim());
  return m
    ? { code: m[1], label: m[2].trim() }
    : { code: null, label: raw.trim() };
}

/** Build a label matcher for one document's vocabulary. */
export function makeLabelMatcher(
  labels: readonly string[],
): (text: string) => { label: string; rest: string } | null {
  // Longest-first so `Address:` wins over `Address` on a header row.
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  return (text: string) => {
    for (const label of byLength) {
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
  };
}

/**
 * Collapse rows into `label → value`. Within a row, everything after a label
 * belongs to it until the next label starts. The FIRST occurrence of a label
 * wins, so a repeated heading later in the document cannot overwrite the data
 * table's value.
 */
export function buildFieldMap(
  rows: PdfRow[],
  labels: readonly string[],
): Map<string, string> {
  const match = makeLabelMatcher(labels);
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
      const hit = match(text);
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

/**
 * PDF bytes → visual rows, via pdfjs.
 *
 * Loaded through a dynamic import because pdfjs ships ESM only (which is also
 * why the jest scripts set `NODE_OPTIONS=--experimental-vm-modules`).
 */
export async function extractRows(data: Uint8Array): Promise<PdfRow[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    // These are static printed forms: no scripts, no external fetches.
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

/** True when any row carries `marker` — our guard on document type. */
export function hasMarker(rows: PdfRow[], marker: string): boolean {
  return rows.some((r) => r.segments.some((s) => s.text.includes(marker)));
}
