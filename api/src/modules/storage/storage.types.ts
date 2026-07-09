/**
 * StorageService — the S3-compatible object-storage abstraction (Task 1.4,
 * DESIGN.md §4.12: "Files go to object storage, never the DB").
 *
 * Every module that stores a file (Attachments today; GRN/invoice scans
 * later) talks ONLY to this interface — never to a driver directly, and
 * never hands raw storage credentials to the frontend. Two drivers
 * implement it (selected by STORAGE_DRIVER, see storage.module.ts):
 *
 *   - S3StorageDriver    — real S3/MinIO via @aws-sdk/client-s3 +
 *                          @aws-sdk/s3-request-presigner. This is the
 *                          production path; it needs a reachable bucket
 *                          (MinIO in docker-compose, or real S3/GCS-S3).
 *   - LocalStorageDriver — filesystem-backed, for machines with no Docker/
 *                          MinIO (this one). "Presigned" URLs are an
 *                          HMAC-signed, expiring app route instead of a
 *                          bucket URL — see local-storage.driver.ts.
 *
 * Swapping STORAGE_DRIVER=s3 + the STORAGE_* S3 envs moves an app to real
 * object storage with ZERO code change anywhere else — every caller only
 * ever sees this interface.
 */
export interface StorageService {
  /** Write `body` to `key`, tagged with `contentType`. Overwrites if present. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;

  /**
   * A short-lived GET URL for `key` (never a raw path/credential). `contentType`
   * is optional context the LOCAL driver embeds in its signed token (so the
   * file-serving route replays the exact content-type that was validated at
   * upload, without trusting the filesystem); the S3 driver ignores it since
   * S3 already stores/returns the object's content-type as metadata.
   */
  getPresignedGetUrl(
    key: string,
    expirySeconds: number,
    contentType?: string,
  ): Promise<string>;

  /** Remove the object at `key`. Safe to call on an already-missing key. */
  deleteObject(key: string): Promise<void>;
}

/** DI token for {@link StorageService} (an interface has no runtime value). */
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
