/**
 * Attachment upload constraints (Task 1.4, DESIGN.md §4.12).
 *
 * Allowlist + size cap are enforced in AttachmentsService BEFORE the object
 * ever reaches storage — a rejected upload never gets a storage key or a DB
 * row. Both are configurable via env so ops can tighten/loosen without a
 * code change.
 */

/** mime → file extension used when composing the storage key. */
export const ALLOWED_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['video/mp4', '.mp4'],
]);

/** Default cap (25 MiB) — overridden by STORAGE_MAX_FILE_SIZE_BYTES. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** PNG magic bytes — validated against decoded signature data-URIs. */
export const PNG_MAGIC_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Default presigned/signed GET URL TTL (5 min) — env STORAGE_URL_TTL_SECONDS. */
export const DEFAULT_PRESIGNED_URL_TTL_SECONDS = 300;

/**
 * Read a numeric env var via `ConfigService`. `ConfigService.get<number>()`
 * does NOT coerce — a `.env` value is always a string, and `get<number>()`'s
 * type param is a bare assertion, not a runtime cast. Reading one "as a
 * number" without this helper silently keeps it a string, which then
 * corrupts arithmetic (`Date.now()/1000 + "300"` string-concatenates to
 * `"...300"` instead of adding 300) — this centralizes the actual coercion,
 * with a NaN-safe fallback.
 */
export function envNumber(
  config: { get<T = string>(key: string): T | undefined },
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Multer's OWN `limits.fileSize`, applied by the `FileInterceptor` decorator
 * — NOT the configurable business cap (STORAGE_MAX_FILE_SIZE_BYTES, checked
 * in AttachmentsService via ConfigService). This exists purely as a memory
 * backstop against abusive request bodies: decorator arguments are
 * evaluated at class-definition time (import time), before Nest's
 * ConfigModule has necessarily loaded `.env` into `process.env`, so it
 * cannot reliably read the configurable env value. Deliberately set well
 * ABOVE any sane STORAGE_MAX_FILE_SIZE_BYTES so the real, configurable
 * limit (enforced in the service, which runs at request time — long after
 * bootstrap, so ConfigService is reliable there) is always the binding one
 * in practice.
 */
export const MULTER_HARD_CEILING_BYTES = 200 * 1024 * 1024;
