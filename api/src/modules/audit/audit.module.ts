import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogController } from './audit-log.controller';
import { AuditService } from './audit.service';

/**
 * AuditModule — Task 0.4 (§4.8): append-only audit trail.
 *
 * The automatic write path lives in the Prisma audit extension
 * (src/prisma/audit.extension.ts), applied globally via PrismaService.
 * This module contributes the read endpoint (GET /audit-log) and the
 * manual AuditService.record() path for non-CRUD events (TRANSITION,
 * LOGIN, APPROVE, REJECT — wired by later tasks).
 */
@Module({
  imports: [AuthModule],
  controllers: [AuditLogController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
