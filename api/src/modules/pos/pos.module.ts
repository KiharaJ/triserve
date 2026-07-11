import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/**
 * PosModule — Task 3.1 (§4.6): the sell side (/api/v1/invoices). Depends on
 * ApprovalsModule (void gating) and AuditModule (semantic lifecycle rows).
 * Payments + receipts (Task 3.2) and accounting posting (Task 3.3) build on the
 * exported InvoicesService.
 */
@Module({
  imports: [AuthModule, ApprovalsModule, AuditModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class PosModule {}
