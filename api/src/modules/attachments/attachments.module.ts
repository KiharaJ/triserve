import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { AttachmentFileController } from './attachment-file.controller';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';

/**
 * AttachmentsModule — Task 1.4 (§4.12): signature + before/after photo
 * capture on jobs (and company-level customer/device attachments), backed
 * by the S3-or-local StorageService (see StorageModule). Audit rows are
 * written automatically by the Prisma audit extension (Attachment is in
 * AUDITED_MODELS) — no direct AuditService dependency needed here.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [AttachmentsController, AttachmentFileController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
