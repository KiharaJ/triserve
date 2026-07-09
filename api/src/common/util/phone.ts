/**
 * Phone / IMEI-serial normalization (Task 1.1, DESIGN.md §4.2).
 *
 * The legacy spreadsheets carry phone numbers in every imaginable shape:
 * Excel scientific notation ('7.53848445E8'), local Tanzanian ('0765447211',
 * '0765 447 211'), international ('+255765447211', '255 765 447211'), and
 * assorted junk. Customers must be findable by phone regardless of how the
 * number was captured, so we store the RAW input (customers.phone /
 * alt_phone) alongside ONE canonical form (phone_normalized /
 * alt_phone_normalized) that all search goes through.
 *
 * Canonical form: E.164-ish '+255XXXXXXXXX' for anything recognizably
 * Tanzanian; '+<digits>' for other international input; bare cleaned digits
 * as a documented fallback for partial/unrecognized numbers (keeps
 * substring phone search working); null for empty/no-digit garbage.
 */

/**
 * Expand an Excel scientific-notation number string ('7.53848445E8' →
 * '753848445') using exact string arithmetic — no float round-trip, so long
 * IMEIs (15 digits) survive intact. Returns null when `value` is not plain
 * scientific notation.
 */
export function expandScientificNotation(value: string): string | null {
  const m = /^(\d+)(?:\.(\d+))?[eE]\+?(\d+)$/.exec(value.trim());
  if (!m) return null;
  const intPart = m[1];
  const fracPart = m[2] ?? '';
  const exponent = Number(m[3]);
  if (exponent > 40) return null; // absurd — not a phone/serial
  const digits = intPart + fracPart;
  const pointAt = intPart.length + exponent; // decimal point position
  if (pointAt < digits.length) return null; // still fractional — not ours
  return digits + '0'.repeat(pointAt - digits.length);
}

/**
 * Normalize a phone number to ONE canonical searchable form.
 *
 * Behavior (documented):
 *   - null/undefined/empty/no digits at all       → null
 *   - '7.53848445E8' (Excel float)                → expanded, then as below
 *   - '0765447211', '0765 447 211' (TZ local)     → '+255765447211'
 *   - '255765447211', '255 765 447211'            → '+255765447211'
 *   - '+255 765-447-211'                          → '+255765447211'
 *   - '765447211' / '753848445' (bare 9-digit)    → '+255765447211'
 *   - '+44 20 7946 0958' (other international)    → '+442079460958'
 *   - anything else with digits (short/partial)   → cleaned digits as-is
 *
 * Separators stripped: spaces, dots, dashes, parentheses, slashes. A '+' is
 * honored only at the start.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (value === '') return null;

  // Excel scientific-notation artifacts first (the '.' is a decimal point
  // there, not a separator).
  const expanded = expandScientificNotation(value);
  if (expanded !== null) value = expanded;

  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return null;

  // Tanzanian forms → E.164 '+255XXXXXXXXX' (9 national digits).
  if (digits.length === 12 && digits.startsWith('255')) {
    return `+${digits}`;
  }
  if (!hasPlus) {
    if (digits.length === 10 && digits.startsWith('0')) {
      return `+255${digits.slice(1)}`;
    }
    if (digits.length === 9 && !digits.startsWith('0')) {
      return `+255${digits}`;
    }
  }

  // Other international input keeps its '+'.
  if (hasPlus) return `+${digits}`;

  // Fallback: cleaned digits (partial/unrecognized) — still searchable.
  return digits;
}

/**
 * Clean an IMEI / serial number for storage & search: expand Excel
 * scientific notation, strip separators (spaces, dashes, dots, slashes),
 * uppercase. Serials are alphanumeric (e.g. 'RF8N40Ww1ZK'), so non-digits
 * are preserved. Returns null for empty/blank input.
 */
export function normalizeImeiSerial(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (value === '') return null;

  const expanded = expandScientificNotation(value);
  if (expanded !== null) value = expanded;

  const cleaned = value.replace(/[\s.\-/]/g, '').toUpperCase();
  return cleaned === '' ? null : cleaned;
}
