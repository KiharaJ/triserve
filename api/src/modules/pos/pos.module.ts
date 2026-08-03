import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountingModule } from '../accounting/accounting.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PublicQuoteController,
  QuoteApprovalController,
} from './quote-approval.controller';
import { QuoteApprovalService } from './quote-approval.service';

/**
 * PosModule — Tasks 3.1/3.2 (§4.6): the sell side (/api/v1/invoices, payments).
 * Depends on ApprovalsModule (void gating) and AuditModule (semantic lifecycle
 * + payment rows). Accounting posting (Task 3.3) will build on these services.
 */
@Module({
  imports: [
    AuthModule,
    ApprovalsModule,
    AuditModule,
    AccountingModule,
    ConfigModule,
  ],
  controllers: [
    InvoicesController,
    PaymentsController,
    // SCMS proposal Module 5 (§6): the out-of-warranty authorization gate —
    // the staff-facing half and the customer-facing (unauthenticated) half.
    QuoteApprovalController,
    PublicQuoteController,
  ],
  providers: [InvoicesService, PaymentsService, QuoteApprovalService],
  exports: [InvoicesService, PaymentsService, QuoteApprovalService],
})
export class PosModule {}
