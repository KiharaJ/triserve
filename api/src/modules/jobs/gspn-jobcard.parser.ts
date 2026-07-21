import type { ServiceType } from '@prisma/client';
import {
  buildFieldMap,
  hasMarker,
  parseGspnDate,
  parseGspnDateTime,
  parseGspnPhone,
  type PdfRow,
} from './gspn-pdf';

/**
 * Parser for Samsung GSPN "Service Order Sheet" job-card PDFs (§4.7).
 *
 * Positional extraction and the shared field-map machinery live in
 * {@link ./gspn-pdf}; this file holds only the job card's own vocabulary and
 * its mapping to a job draft. {@link parseJobCard} is pure, so the suite can
 * test it from synthetic rows and no real customer PDF (which carries a name,
 * phone and home address) needs committing to the repo.
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
export const JOBCARD_LABELS: readonly string[] = [
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

/** Pure rows → draft mapping. Never throws; unrecognised fields become null. */
export function parseJobCard(rows: PdfRow[]): ParsedJobCard {
  const f = buildFieldMap(rows, JOBCARD_LABELS);
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

/** True when the extracted rows look like a GSPN Service Order Sheet. */
export function looksLikeJobCard(rows: PdfRow[]): boolean {
  return hasMarker(rows, JOBCARD_MARKER);
}
