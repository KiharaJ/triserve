import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LocalStorageDriver } from './drivers/local-storage.driver';
import { S3StorageDriver } from './drivers/s3-storage.driver';
import { STORAGE_SERVICE } from './storage.types';

/**
 * StorageModule (Task 1.4, DESIGN.md §4.12) — provides {@link StorageService}
 * (see storage.types.ts) under the STORAGE_SERVICE DI token, backed by
 * whichever driver STORAGE_DRIVER selects:
 *
 *   STORAGE_DRIVER=local (default, this machine) → LocalStorageDriver
 *   STORAGE_DRIVER=s3                            → S3StorageDriver (MinIO/S3)
 *
 * Every consumer (AttachmentsModule today) injects `STORAGE_SERVICE` and
 * only ever sees the interface — swapping the env var swaps the backing
 * store with no consumer code changes.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_SERVICE,
      useFactory: (config: ConfigService) => {
        const driver = config.get<string>('STORAGE_DRIVER', 'local');
        return driver === 's3'
          ? new S3StorageDriver(config)
          : new LocalStorageDriver(config);
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
