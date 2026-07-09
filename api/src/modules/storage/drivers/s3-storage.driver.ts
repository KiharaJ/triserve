import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import type { StorageService } from '../storage.types';

/**
 * Real S3-compatible {@link StorageService} driver (Task 1.4) — MinIO in
 * dev (see docker-compose.yml's optional `minio` service) or any real
 * S3/GCS-S3-interop bucket in production. Selected via STORAGE_DRIVER=s3.
 *
 * NOT exercised in this environment (no Docker/MinIO here — see
 * LocalStorageDriver, the default) but is a complete, working
 * implementation: point STORAGE_ENDPOINT/STORAGE_BUCKET/STORAGE_ACCESS_KEY/
 * STORAGE_SECRET_KEY/STORAGE_REGION/STORAGE_FORCE_PATH_STYLE at a running
 * MinIO/S3 and flip STORAGE_DRIVER=s3 — zero code changes elsewhere,
 * because every caller only ever depends on the {@link StorageService}
 * interface.
 */
export class S3StorageDriver implements StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('STORAGE_BUCKET', 'triserve-attachments');
    this.client = new S3Client({
      endpoint: config.get<string>('STORAGE_ENDPOINT'),
      region: config.get<string>('STORAGE_REGION', 'us-east-1'),
      forcePathStyle:
        config.get<string>('STORAGE_FORCE_PATH_STYLE', 'true') === 'true',
      credentials: {
        accessKeyId: config.get<string>('STORAGE_ACCESS_KEY', ''),
        secretAccessKey: config.get<string>('STORAGE_SECRET_KEY', ''),
      },
    });
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    expirySeconds: number,
  ): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expirySeconds });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
