import { imeiCheckDigit } from '@triserve/shared';

/**
 * Build a VALID 15-digit IMEI for test fixtures.
 *
 * SCMS proposal Module 1 (§2 step 1) makes the API reject any handset IMEI
 * that fails the Luhn check, so fixtures can no longer invent digits. This
 * takes whatever seed a spec wants its device to be recognisable by, pads it
 * into a 14-digit body, and appends the correct check digit.
 *
 * Deterministic on purpose: a spec that asserts on the exact stored value must
 * be able to compute the same string twice, and a random IMEI would make a
 * failure impossible to reproduce.
 *
 *   testImei(1)        → '350000000000017'
 *   testImei('4207')   → '350000000042072'
 */
export function testImei(seed: number | string): string {
  const digits = String(seed).replace(/\D/g, '');
  if (digits.length > 14) {
    throw new Error(`testImei seed '${seed}' is too long (max 14 digits)`);
  }
  // '35' is a real Type Allocation Code prefix, so fixtures look like the
  // handsets they stand in for rather than obviously synthetic numbers.
  const body = ('35' + '0'.repeat(12) + digits).slice(-14);
  const check = imeiCheckDigit(body);
  if (check === null) {
    throw new Error(`testImei could not build a body from seed '${seed}'`);
  }
  return body + String(check);
}
