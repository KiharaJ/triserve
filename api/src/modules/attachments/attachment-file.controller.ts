import { Controller, Get, Param, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLocalStoragePath } from '../storage/local-storage-path.util';
import { verifyFileToken } from '../storage/signed-url.util';

/**
 * GET /attachments/file/:token — the LOCAL storage driver's stand-in for a
 * real S3 presigned URL (Task 1.4; no Docker/MinIO on this machine, see
 * LocalStorageDriver). Deliberately NOT behind AuthGuard/PermissionsGuard:
 * a real presigned S3 URL is likewise usable by anyone who holds it,
 * without a bearer token — the security property is the HMAC-signed,
 * short-lived, tamper-proof `token` itself (see signed-url.util.ts), not a
 * session check. A separate controller (rather than a route on
 * AttachmentsController) makes that "this one route is intentionally
 * public" decision visible at a glance.
 *
 * Irrelevant when STORAGE_DRIVER=s3: that driver hands back a REAL bucket
 * presigned URL that never touches this app, so this route is simply never
 * referenced.
 */
@Controller('attachments')
export class AttachmentFileController {
  private readonly baseDir: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.baseDir = config.get<string>(
      'STORAGE_LOCAL_DIR',
      join(process.cwd(), '.storage'),
    );
    this.secret = config.get<string>(
      'STORAGE_URL_SECRET',
      'dev-insecure-storage-url-secret-change-me',
    );
  }

  @Get('file/:token')
  async streamFile(
    @Param('token') token: string,
    @Res() res: Response,
  ): Promise<void> {
    const payload = verifyFileToken(token, this.secret);
    if (!payload) {
      this.notFound(res);
      return;
    }

    let path: string;
    try {
      path = resolveLocalStoragePath(this.baseDir, payload.key);
    } catch {
      this.notFound(res);
      return;
    }

    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.notFound(res);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', payload.mime);
    res.setHeader('Content-Length', String(size));
    createReadStream(path).pipe(res);
  }

  private notFound(res: Response): void {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'File not found or link expired' },
    });
  }
}
