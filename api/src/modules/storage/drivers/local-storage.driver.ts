import { ConfigService } from '@nestjs/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveLocalStoragePath } from '../local-storage-path.util';
import { signFileToken } from '../signed-url.util';
import type { StorageService } from '../storage.types';

/**
 * Filesystem-backed {@link StorageService} driver (Task 1.4) — the default
 * on this machine, since there is no Docker/MinIO to run the real S3 driver
 * against. Objects are written under `STORAGE_LOCAL_DIR` (default
 * `api/.storage`, gitignored); "presigned" GET URLs are an HMAC-signed,
 * expiring app route (`GET /attachments/file/:token`, see AttachmentFileController)
 * instead of a bucket URL — see signed-url.util.ts for why that is safe.
 *
 * Same interface as {@link S3StorageDriver} — swapping STORAGE_DRIVER=s3
 * (+ MinIO/S3 envs) moves to real object storage with no caller changes.
 */
export class LocalStorageDriver implements StorageService {
  private readonly baseDir: string;
  private readonly secret: string;
  /** Optional absolute origin to prefix the signed URL with (e.g. in a
   * multi-origin deployment); defaults to a relative path, which every
   * caller in this codebase (supertest, same-origin frontend fetch) resolves
   * against the API's own origin. */
  private readonly publicBaseUrl: string;

  constructor(config: ConfigService) {
    this.baseDir = config.get<string>(
      'STORAGE_LOCAL_DIR',
      join(process.cwd(), '.storage'),
    );
    this.secret = config.get<string>(
      'STORAGE_URL_SECRET',
      'dev-insecure-storage-url-secret-change-me',
    );
    this.publicBaseUrl = config.get<string>('APP_BASE_URL', '');
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    const path = resolveLocalStoragePath(this.baseDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  getPresignedGetUrl(
    key: string,
    expirySeconds: number,
    contentType?: string,
  ): Promise<string> {
    const token = signFileToken(
      { key, mime: contentType ?? 'application/octet-stream' },
      expirySeconds,
      this.secret,
    );
    return Promise.resolve(
      `${this.publicBaseUrl}/api/v1/attachments/file/${token}`,
    );
  }

  async deleteObject(key: string): Promise<void> {
    const path = resolveLocalStoragePath(this.baseDir, key);
    await rm(path, { force: true });
  }
}
