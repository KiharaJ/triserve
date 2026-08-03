import { UnprocessableEntityException } from '@nestjs/common';
import {
  validateDeviceIdentifier,
  type IdentifierCategory,
} from '@triserve/shared';

/**
 * Server-side enforcement of the device-identifier rule
 * (SCMS proposal Module 1, §2 step 1).
 *
 * "The system runs an automated validation script on the input field. For
 * mobile devices, it enforces a strict 15-digit numeric IMEI rule (Luhn
 * algorithm check). For home appliances or TVs, it matches alphanumeric regex
 * strings according to brand models."
 *
 * The RULE itself lives in @triserve/shared so the web app can validate as the
 * agent types; this is the API-side gate that actually decides. Call it with
 * the NORMALIZED identifier (after `normalizeImeiSerial`), because the rule is
 * expressed against the canonical form — separators are stripped, not rejected.
 *
 * Throws 422 (surfaced by the global filter as
 * `{ error: { code: 'UNPROCESSABLE_ENTITY', message } }`) with a message
 * written for the person at the counter, not for a developer.
 */
export function assertValidDeviceIdentifier(
  category: string,
  normalized: string | null | undefined,
): void {
  const check = validateDeviceIdentifier(
    category as IdentifierCategory,
    normalized,
  );
  if (!check.ok) {
    throw new UnprocessableEntityException(check.reason);
  }
}
