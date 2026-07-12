import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

/**
 * PosModule — Tasks 3.1/3.2 (§4.6): the sell side (/api/v1/invoices, payments).
 * Depends on ApprovalsModule (void gating) and AuditModule (semantic lifecycle
 * + payment rows). Accounting posting (Task 3.3) will build on these services.
 */
@Module({
  imports: [AuthModule, ApprovalsModule, AuditModule, AccountingModule],
  controllers: [InvoicesController, PaymentsController],
  providers: [InvoicesService, PaymentsService],
  exports: [InvoicesService, PaymentsService],
})
export class PosModule {}
