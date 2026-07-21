/**
 * Unit tests for the GSPN job-card parser (§4.7). No database, no HTTP.
 *
 * Fixtures are SYNTHETIC on purpose. A real Samsung job card carries a
 * customer's name, phone number and home address, so committing one to the
 * repo to use as a test fixture would put third-party personal data in git
 * history forever. The layout below reproduces the card's structure — a
 * two-column label/value table — using invented values.
 */
import {
  buildFieldMap,
  extractRows,
  looksLikeJobCard,
  parseGspnDate,
  parseGspnDateTime,
  parseGspnPhone,
  parseJobCard,
  type PdfRow,
} from './gspn-jobcard.parser';

/** Build a row the way extractRows would, from `x:text` pairs. */
function row(y: number, page: number, ...pairs: [number, string][]): PdfRow {
  return { page, y, segments: pairs.map(([x, text]) => ({ x, text })) };
}

/**
 * The real card's geometry: labels at x=34 (left) and x=309 (right), values
 * at x=144 and x=418. Values that GSPN splits into several runs (an address,
 * the serial cell) are reproduced as several segments.
 */
function jobCardRows(): PdfRow[] {
  return [
    row(735, 1, [206, 'Service Order Sheet']),
    row(
      704,
      1,
      [31, 'Service Order No : 4295708333'],
      [361, 'Service Center:'],
      [418, '0004778756 - TEST ASC'],
    ),
    row(
      692,
      1,
      [31, 'Customer No : 7704818657'],
      [361, 'Address:'],
      [396, 'SAM NUJOMA ROAD 000'],
    ),
    row(
      668,
      1,
      [34, 'Customer Name'],
      [144, 'TEST CUSTOMER NAME'],
      [309, 'Request Date'],
      [421, '07.15.2026'],
    ),
    row(
      653,
      1,
      [34, 'Address'],
      [144, 'MBANDE'],
      [184, 'TEMEKE'],
      [220, 'Daressalaam'],
      [273, 'TZ'],
    ),
    row(
      639,
      1,
      [34, 'Appointment Date'],
      [144, '07.15.2026 (09:29:12)'],
      [309, 'Engineer Code'],
    ),
    row(
      625,
      1,
      [34, 'Telephone'],
      [144, '[Home]0713951123[Office]0713951123'],
      [309, 'Fax'],
    ),
    row(
      611,
      1,
      [34, 'Model Name'],
      [144, 'SM-A065FZKDAFB'],
      [309, 'Serial No ( IMEI )'],
      [418, 'R83L40GG4XW'],
      [483, '( ********7260294 )'],
    ),
    row(
      596,
      1,
      [34, 'Purchase Date'],
      [144, '07.12.2026'],
      [309, 'Service Type'],
      [418, 'Carry In'],
    ),
    row(580, 1, [144, 'Full Warranty'], [309, 'Repair Received']),
    row(566, 1, [144, 'Labor only'], [309, 'Repair Completed']),
    row(559, 1, [34, 'Warranty Status']),
    row(551, 1, [144, 'Parts only'], [309, 'Goods Delivered']),
    row(537, 1, [144, 'Out of warranty'], [309, 'Return by / Date']),
    row(521, 1, [34, 'Accessory'], [146, 'SIM TRAY']),
    row(507, 1, [34, 'Defect Description'], [146, 'DEVICE LOCK']),
    row(493, 1, [34, 'Repair Description']),
    row(479, 1, [34, 'Remark']),
  ];
}

describe('parseJobCard — the Samsung Service Order Sheet', () => {
  it('maps every field the card carries', () => {
    const parsed = parseJobCard(jobCardRows());
    expect(parsed).toMatchObject({
      so_number: '4295708333',
      customer_name: 'TEST CUSTOMER NAME',
      address: 'MBANDE TEMEKE Daressalaam TZ',
      model: 'SM-A065FZKDAFB',
      serial: 'R83L40GG4XW',
      imei_masked: '********7260294',
      purchase_date: '2026-07-12',
      service_type: 'CARRY_IN',
      accessories_held: 'SIM TRAY',
      fault_reported: 'DEVICE LOCK',
      appointment_at: '2026-07-15T09:29:12.000Z',
    });
    // Blank on the card → null, not an empty string.
    expect(parsed.repair_description).toBeNull();
  });

  it('NEVER infers coverage, and says why on every import', () => {
    const parsed = parseJobCard(jobCardRows());
    // The tick is a drawn mark, not text — guessing here would be guessing
    // about money. See the parser header.
    expect(parsed.coverage).toBeNull();
    expect(parsed.warnings[0]).toMatch(/coverage was not read/i);
  });

  it('flags the masked IMEI so callers match on serial instead', () => {
    const parsed = parseJobCard(jobCardRows());
    expect(parsed.imei_masked).toContain('*');
    expect(parsed.warnings.join(' ')).toMatch(/masks the IMEI/i);
  });

  it("a right-column label terminates the left column's value", () => {
    // The two-column table shares one baseline: without knowing that
    // "Serial No ( IMEI )" is a label, the model swallows the rest of the row.
    const fields = buildFieldMap(jobCardRows());
    expect(fields.get('Model Name')).toBe('SM-A065FZKDAFB');
    expect(fields.get('Request Date')).toBe('07.15.2026');
  });

  it("the header's `Address:` does not capture the customer's `Address`", () => {
    // They differ only by a colon — one is the service centre's.
    const fields = buildFieldMap(jobCardRows());
    expect(fields.get('Address:')).toBe('SAM NUJOMA ROAD 000');
    expect(fields.get('Address')).toBe('MBANDE TEMEKE Daressalaam TZ');
  });

  it('an unrecognised service type warns instead of silently dropping', () => {
    const rows = jobCardRows().map((r) =>
      r.y === 596
        ? row(
            596,
            1,
            [34, 'Purchase Date'],
            [144, '07.12.2026'],
            [309, 'Service Type'],
            [418, 'Teleporter'],
          )
        : r,
    );
    const parsed = parseJobCard(rows);
    expect(parsed.service_type).toBeNull();
    expect(parsed.warnings.join(' ')).toMatch(
      /Unrecognised service type "Teleporter"/,
    );
  });

  it('rejects a PDF that is not a job card', () => {
    expect(looksLikeJobCard(jobCardRows())).toBe(true);
    expect(looksLikeJobCard([row(700, 1, [10, 'Some other document'])])).toBe(
      false,
    );
  });
});

describe('GSPN field formats', () => {
  it('reads dates as MM.DD.YYYY', () => {
    expect(parseGspnDate('07.12.2026')).toBe('2026-07-12');
    // 13 is not a month, so the card cannot be day-first — this value is
    // what pins the order down.
    expect(parseGspnDate('05.13.2026')).toBe('2026-05-13');
    expect(parseGspnDate('13.05.2026')).toBeNull();
    expect(parseGspnDate('')).toBeNull();
    expect(parseGspnDate(null)).toBeNull();
  });

  it('reads the optional time in an appointment cell', () => {
    expect(parseGspnDateTime('07.15.2026 (09:29:12)')).toBe(
      '2026-07-15T09:29:12.000Z',
    );
    expect(parseGspnDateTime('07.15.2026')).toBe('2026-07-15T00:00:00.000Z');
  });

  it('takes the first number out of a tagged telephone cell', () => {
    expect(parseGspnPhone('[Home]0713951123[Office]0713951123')).toBe(
      '0713951123',
    );
    expect(parseGspnPhone('0765111222')).toBe('0765111222');
    expect(parseGspnPhone(null)).toBeNull();
  });
});

/**
 * REGRESSION (found against a real card): rows were grouped by y across the
 * WHOLE document, but page 2 is the terms and conditions and its lines sit at
 * the same y values as page 1's data table — so T&C prose spliced itself into
 * the middle of the customer's name, address and model. Rows must be scoped
 * per page.
 */
describe('extractRows — pages must not merge', () => {
  /** A minimal two-page PDF with text at the SAME y on both pages. */
  function twoPagePdf(): Uint8Array {
    const content = (text: string): string =>
      `BT /F1 10 Tf 34 700 Td (${text}) Tj ET`;
    const page1 = content('Service Order Sheet');
    const page2 = content('TERMS AND CONDITIONS PROSE');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${page1.length} >>\nstream\n${page1}\nendstream`,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
      `<< /Length ${page2.length} >>\nstream\n${page2}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];

    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefStart = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(pdf, 'latin1'));
  }

  it('keeps same-y text from different pages in different rows', async () => {
    const rows = await extractRows(twoPagePdf());
    const joined = rows.map((r) => r.segments.map((s) => s.text).join(' '));
    expect(joined).toContain('Service Order Sheet');
    expect(joined).toContain('TERMS AND CONDITIONS PROSE');
    // The whole point: page 1's heading must not carry page 2's prose.
    expect(joined).not.toContain(
      'Service Order Sheet TERMS AND CONDITIONS PROSE',
    );
    expect(rows.map((r) => r.page).sort()).toEqual([1, 2]);
  });
});
