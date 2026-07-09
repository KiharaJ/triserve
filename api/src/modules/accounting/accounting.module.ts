import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { AccountsController } from './accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalEntriesController } from './journal-entries.controller';
import { JournalService } from './journal.service';

/**
 * AccountingModule — Task 0.6 (§4.9 / E1): chart of accounts + double-entry
 * journal TABLES with the manual-journal endpoint. No automatic posting yet
 * — Phase 3 switches that on by calling the exported JournalService.post()
 * from payment/GRN/warranty/consumption flows (same balance invariant, no
 * schema rebuild).
 */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [AccountsController, JournalEntriesController],
  providers: [ChartOfAccountsService, JournalService],
  exports: [JournalService],
})
export class AccountingModule {}
