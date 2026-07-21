/**
 * Unit tests for the GSPN Warranty Claim Detail parser (§4.7). No DB, no HTTP.
 *
 * Fixtures are SYNTHETIC: a real claim carries a customer's name and phone
 * number, so using one as a committed fixture would put third-party personal
 * data in git history permanently. The geometry below reproduces the real
 * document's structure — including the parts table's wrapped cells, which is
 * the part most likely to break.
 */
import type { PdfRow } from '../jobs/gspn-pdf';
import { parseUsdToMinor } from '../jobs/gspn-pdf';
import {
  looksLikeClaim,
  parseClaim,
  parsePartLines,
} from './gspn-claim.parser';

function row(y: number, ...pairs: [number, string][]): PdfRow {
  return { page: 1, y, segments: pairs.map(([x, text]) => ({ x, text })) };
}

/** The claim's two-column body, at the real document's x positions. */
function claimRows(): PdfRow[] {
  return [
    row(719, [174, 'Warranty Claim Detail']),
    row(670, [31, 'Samsung Ref. No'], [145, '691010405931']),
    row(656, [31, 'ASC Claim No'], [145, '4294486119']),
    row(
      642,
      [31, 'Service Type'],
      [147, 'Pick up Service'],
      [309, 'Status'],
      [424, '20-Data closed'],
    ),
    row(
      629,
      [31, 'Ticket No'],
      [145, '4294486119'],
      [309, 'Tracking Type'],
      [424, 'In Bound'],
    ),
    row(615, [31, 'Customer Name'], [145, 'TEST CLAIM CUSTOMER']),
    row(574, [31, 'Zip Code'], [309, 'Phone'], [422, '0684784460']),
    row(
      560,
      [31, 'Model Name'],
      [145, 'SM-A065FZDDAFB'],
      [309, 'Serial No'],
      [422, 'R83L20HLHAJ'],
    ),
    row(
      547,
      [31, 'CRT/ESM/IMEI'],
      [145, '********1778019'],
      [309, 'Defect Type'],
      [424, 'Level 2 Service'],
    ),
    row(
      533,
      [31, 'Purchase Date'],
      [145, '05.13.2026'],
      [309, 'Repair Received Date'],
      [422, '05.21.2026'],
    ),
    row(
      519,
      [31, 'Completed Date'],
      [145, '05.25.2026'],
      [309, 'Delivered Date'],
      [422, '05.25.2026'],
    ),
    // Codes arrive split across runs: `1 -` then `Defect`.
    row(
      506,
      [31, 'Condition Code'],
      [145, '1 -'],
      [157, 'Defect'],
      [309, 'Symptom Code'],
      [422, 'T83 -'],
      [443, 'USB connectivity problem'],
    ),
    row(
      492,
      [31, 'Defect Code'],
      [145, 'Q -'],
      [158, 'Short'],
      [309, 'Repair Code'],
      [421, 'A01 -'],
      [443, 'Electrical parts replacement'],
    ),
    row(479, [31, 'Defect Description'], [145, 'NOT CHARGING']),
    row(465, [31, 'Repair Description'], [145, 'SUB PBA REPLACED']),
    row(
      451,
      [31, 'In/Out Warranty'],
      [147, 'In Warranty'],
      [309, 'Total Amount'],
      [422, '40.30'],
    ),
    row(437, [31, 'Remarks']),
    row(
      424,
      [31, 'Labour Cost'],
      [145, '16.52'],
      [309, 'Part Cost'],
      [422, '12.83'],
    ),
    row(
      410,
      [31, 'Shipping/Other'],
      [147, '10.95 / 0.00'],
      [309, 'Tax'],
      [422, '0.00'],
    ),
    // Parts table: a three-baseline header, then ONE item wrapped over two.
    row(383, [394, 'Unit'], [544, 'Parts']),
    row(
      377,
      [31, 'No'],
      [48, 'Location'],
      [104, 'Part No.'],
      [201, 'Description Spceification'],
      [368, 'Qty'],
      [427, 'Amount'],
      [476, 'Invoice No'],
    ),
    row(371, [392, 'Price'], [535, 'Serial No']),
    row(357, [106, 'GH81-'], [161, 'SVC JDM-ASSY SUB PBA_COMMON_A065;SM-']),
    row(
      348,
      [36, '1'],
      [104, '26450A'],
      [159, 'A065'],
      [369, '001'],
      [393, '12.83'],
      [435, '12.83'],
    ),
  ];
}

describe('parseClaim — the Warranty Claim Detail', () => {
  it("reads GSPN's three reference numbers and its raw status", () => {
    const c = parseClaim(claimRows());
    expect(c.claim_no).toBe('4294486119');
    expect(c.samsung_ref_no).toBe('691010405931');
    expect(c.ticket_no).toBe('4294486119');
    // Kept verbatim — Samsung revises this vocabulary without notice.
    expect(c.gspn_status).toBe('20-Data closed');
  });

  it('splits the cost the way GSPN settles it, in USD minor units', () => {
    const c = parseClaim(claimRows());
    expect(c.labour_amount_usd).toBe('1652');
    expect(c.parts_amount_usd).toBe('1283');
    // `10.95 / 0.00` — shipping and "other" share a cell; shipping is banked.
    expect(c.shipping_amount_usd).toBe('1095');
    expect(c.tax_amount_usd).toBe('0');
    expect(c.claim_amount_usd).toBe('4030');
    // 1652 + 1283 + 1095 + 0 = 4030, so nothing to complain about.
    expect(c.warnings).toEqual([]);
  });

  it('warns when the components do not reconcile to the printed total', () => {
    const rows = claimRows().map((r) =>
      r.y === 424
        ? row(
            424,
            [31, 'Labour Cost'],
            [145, '99.99'],
            [309, 'Part Cost'],
            [422, '12.83'],
          )
        : r,
    );
    const c = parseClaim(rows);
    // A mis-read component is worse than a missing one — say so loudly.
    expect(c.warnings.join(' ')).toMatch(/does not match the printed total/);
  });

  it('splits the diagnosis codes into code + label', () => {
    const c = parseClaim(claimRows());
    expect(c.condition_code).toEqual({ code: '1', label: 'Defect' });
    expect(c.symptom_code).toEqual({
      code: 'T83',
      label: 'USB connectivity problem',
    });
    expect(c.defect_code).toEqual({ code: 'Q', label: 'Short' });
    expect(c.repair_code).toEqual({
      code: 'A01',
      label: 'Electrical parts replacement',
    });
    // Defect Type prints with NO code prefix — keep the label, don't drop it.
    expect(c.defect_type).toEqual({ code: null, label: 'Level 2 Service' });
  });

  it('maps In/Out Warranty and the service type', () => {
    const c = parseClaim(claimRows());
    expect(c.warranty_status).toBe('IW');
    expect(c.service_type).toBe('PICKUP');
  });

  it('reads the repair milestones', () => {
    const c = parseClaim(claimRows());
    expect(c.purchase_date).toBe('2026-05-13');
    expect(c.repair_received_at).toBe('2026-05-21');
    expect(c.completed_at).toBe('2026-05-25');
    expect(c.delivered_at).toBe('2026-05-25');
  });

  it('rejects a PDF that is not a claim', () => {
    expect(looksLikeClaim(claimRows())).toBe(true);
    expect(looksLikeClaim([row(700, [10, 'Service Order Sheet'])])).toBe(false);
  });
});

describe('parsePartLines — the wrapped parts table', () => {
  it('rejoins a part number split across two baselines', () => {
    const [line] = parsePartLines(claimRows());
    // `GH81-` + `26450A`: GSPN wraps mid-token, so no separator goes between
    // them. A space here would corrupt the one field that is an identifier.
    expect(line.part_no).toBe('GH81-26450A');
    expect(line.description).toBe('SVC JDM-ASSY SUB PBA_COMMON_A065;SM-A065');
  });

  it('reads qty, unit price and amount off the wrapped header columns', () => {
    const [line] = parsePartLines(claimRows());
    expect(line.line_no).toBe(1);
    // GSPN zero-pads quantities.
    expect(line.qty).toBe(1);
    // "Unit"/"Price" wraps across the header rows — the column must still resolve.
    expect(line.unit_price_usd).toBe('1283');
    expect(line.amount_usd).toBe('1283');
    expect(line.part_serial_no).toBeNull();
  });

  it('returns nothing when there is no parts table', () => {
    expect(parsePartLines([row(700, [10, 'Warranty Claim Detail'])])).toEqual(
      [],
    );
  });

  it('warns when a claim carries no part lines', () => {
    const c = parseClaim(claimRows().filter((r) => r.y > 390));
    expect(c.lines).toEqual([]);
    expect(c.warnings.join(' ')).toMatch(/No part lines/);
  });
});

describe('parseUsdToMinor', () => {
  it('converts without ever touching a float', () => {
    // 40.30 * 100 is 4029.9999... in binary floating point.
    expect(parseUsdToMinor('40.30')).toBe('4030');
    expect(parseUsdToMinor('0.00')).toBe('0');
    expect(parseUsdToMinor('1,234.5')).toBe('123450');
    expect(parseUsdToMinor('7')).toBe('700');
    expect(parseUsdToMinor(null)).toBeNull();
    expect(parseUsdToMinor('n/a')).toBeNull();
  });
});
