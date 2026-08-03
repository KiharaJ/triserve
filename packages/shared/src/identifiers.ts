/**
 * Device identifier validation — IMEI (Luhn) and per-category serial shapes.
 *
 * Proposal Module 1, step 1: intake integrity starts at the identifier. A
 * mistyped IMEI poisons everything downstream — warranty lookup misses, the
 * device history attaches to the wrong unit, and the Samsung claim is
 * rejected weeks later. So the counter agent's input is validated at the
 * point of capture, by category:
 *
 *   HHP (phones/tablets) → strict 15 numeric digits passing the Luhn check.
 *   CE / AC / REF        → alphanumeric serial, 6–30 chars (Samsung serials
 *                          are 11–15 alphanumerics, e.g. `RF8N40WW1ZK`;
 *                          other brands run longer, hence the loose bound).
 *
 * Lives in @triserve/shared so the web app can validate as the agent types
 * and the API can enforce the SAME rule server-side — one vocabulary, no
 * drift. The API is the real gate; the UI is a courtesy.
 *
 * Deliberately NOT a normalizer: pass the value through
 * `normalizeImeiSerial()` (api/src/common/util/phone.ts) FIRST, then validate
 * the canonical form.
 */

/** Device categories that carry an identifier rule (mirrors DeviceCategory). */
export type IdentifierCategory = 'HHP' | 'CE' | 'AC' | 'REF' | 'OTHER';

/** Outcome of a check — `ok` plus a human reason when it failed. */
export interface IdentifierCheck {
  ok: boolean;
  /** Present only when `ok` is false; safe to show to the counter agent. */
  reason?: string;
}

/** 15 numeric digits — the structural half of the IMEI rule. */
export const IMEI_PATTERN = /^\d{15}$/;

/**
 * Serial shape for non-phone hardware: alphanumeric, 6–30 chars. Hyphens and
 * spaces are separators stripped during normalization, so they must NOT
 * appear here.
 */
export const SERIAL_PATTERN = /^[A-Z0-9]{6,30}$/;

/**
 * Luhn (mod-10) checksum, the check digit rule every GSM IMEI satisfies.
 * Doubles every second digit from the right, subtracts 9 from any result
 * above 9, and requires the total to be divisible by 10.
 *
 * Returns false for anything that is not exactly 15 digits — the caller
 * gets one answer for "is this a real IMEI", not two.
 */
export function isValidImei(value: string): boolean {
  if (!IMEI_PATTERN.test(value)) return false;

  let sum = 0;
  // Walk right → left so "every second digit" is unambiguous regardless of
  // length (it is always 15 here, but the idiom is the standard one).
  for (let i = 14; i >= 0; i--) {
    let digit = value.charCodeAt(i) - 48;
    if ((14 - i) % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Compute the Luhn check digit for a 14-digit IMEI body — i.e. what the 15th
 * digit must be. Used by tests and by the importer when repairing legacy
 * spreadsheet IMEIs that lost their trailing digit to Excel rounding.
 * Returns null unless `body` is exactly 14 digits.
 */
export function imeiCheckDigit(body: string): number | null {
  if (!/^\d{14}$/.test(body)) return null;
  let sum = 0;
  for (let i = 13; i >= 0; i--) {
    let digit = body.charCodeAt(i) - 48;
    // The check digit occupies position 15, so the doubling parity here is
    // the opposite of isValidImei's (where position 15 is index 14, undoubled).
    if ((13 - i) % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Validate a NORMALIZED device identifier against its category rule.
 *
 * An empty/absent identifier is accepted here: plenty of CE/AC/REF units
 * arrive with the label rubbed off, and refusing intake over it would push
 * the front desk back to paper. Requiring one for a given category is a
 * separate policy decision made by the caller.
 */
export function validateDeviceIdentifier(
  category: IdentifierCategory,
  value: string | null | undefined,
): IdentifierCheck {
  if (value == null || value === '') return { ok: true };

  if (category === 'HHP') {
    if (!IMEI_PATTERN.test(value)) {
      return {
        ok: false,
        reason: `IMEI must be exactly 15 digits (got ${value.length} character${
          value.length === 1 ? '' : 's'
        })`,
      };
    }
    if (!isValidImei(value)) {
      return {
        ok: false,
        reason:
          'IMEI failed the Luhn checksum — re-scan or re-key it (a digit is wrong)',
      };
    }
    return { ok: true };
  }

  // Everything else: a plausible alphanumeric serial. A 15-digit numeric
  // string on a TV is far more likely a mis-categorised phone than a serial,
  // but that is a judgement call for the agent, not a hard block — so the
  // rule stays structural.
  if (!SERIAL_PATTERN.test(value)) {
    return {
      ok: false,
      reason:
        'Serial number must be 6–30 letters/digits (spaces and dashes are ignored)',
    };
  }
  return { ok: true };
}

/**
 * Label for the identifier field, by category — the intake form asks for
 * "IMEI" on a phone and "Serial number" on a fridge.
 */
export function identifierLabel(category: IdentifierCategory): string {
  return category === 'HHP' ? 'IMEI' : 'Serial number';
}
