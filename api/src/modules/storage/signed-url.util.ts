import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed, expiring token that stands in for a real S3 presigned URL
 * when running the LOCAL storage driver (Task 1.4 — no Docker/MinIO on this
 * machine). The token encodes exactly what a request to `GET
 * /attachments/file/:token` needs to safely serve the file WITHOUT the
 * client ever seeing the on-disk path or any storage credential:
 *
 *   - `key`  — the object's storage key (so the route knows what to stream)
 *   - `mime` — the content-type to answer with (trust the DB-validated
 *              value captured at upload time, not whatever the filesystem
 *              thinks; avoids a second mime-sniff/trust decision)
 *   - `exp`  — unix-seconds expiry (mirrors a presigned URL's TTL)
 *
 * Safety properties:
 *   - Tamper-proof: the payload is HMAC-SHA256 signed with STORAGE_URL_SECRET
 *     (server-only secret, never sent to the client) — flipping any byte of
 *     `key`/`mime`/`exp` invalidates the signature.
 *   - Expiring: `verifySignedToken` rejects tokens whose `exp` has passed,
 *     same as a real presigned URL's `X-Amz-Expires`.
 *   - No path/credential leakage: the client only ever holds the opaque
 *     token, never the STORAGE_LOCAL_DIR path or STORAGE_URL_SECRET.
 *   - Constant-time signature comparison (`timingSafeEqual`) to avoid a
 *     timing side-channel on signature verification.
 *
 * NOT a substitute for TLS: like a real presigned URL, anyone who obtains
 * the token/URL before it expires can use it — acceptable for the same
 * reason S3 presigned URLs are acceptable (short TTL, HTTPS in production).
 */
export interface SignedFilePayload {
  key: string;
  mime: string;
  exp: number;
}

function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input: string): Buffer {
  const padded = input
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Build a signed `{key,mime,exp}` token good for `expirySeconds` from now. */
export function signFileToken(
  payload: Omit<SignedFilePayload, 'exp'>,
  expirySeconds: number,
  secret: string,
): string {
  const full: SignedFilePayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expirySeconds,
  };
  const data = base64url(Buffer.from(JSON.stringify(full), 'utf8'));
  const sig = base64url(hmac(data, secret));
  return `${data}.${sig}`;
}

/** Verify + decode a token; returns null if malformed, tampered, or expired. */
export function verifyFileToken(
  token: string,
  secret: string,
): SignedFilePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;

  let expectedSig: Buffer;
  let givenSig: Buffer;
  try {
    expectedSig = hmac(data, secret);
    givenSig = fromBase64url(sig);
  } catch {
    return null;
  }
  if (
    expectedSig.length !== givenSig.length ||
    !timingSafeEqual(expectedSig, givenSig)
  ) {
    return null;
  }

  let payload: SignedFilePayload;
  try {
    payload = JSON.parse(
      fromBase64url(data).toString('utf8'),
    ) as SignedFilePayload;
  } catch {
    return null;
  }
  if (
    typeof payload.key !== 'string' ||
    typeof payload.mime !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}
