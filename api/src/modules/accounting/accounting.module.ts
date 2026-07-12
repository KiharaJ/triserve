import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { AccountsController } from './accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalEntriesController } from './journal-entries.controller';
import { JournalService } from './journal.service';
import { PostingService } from './posting.service';

/**
 * AccountingModule — Task 0.6 (§4.9 / E1): chart of accounts + double-entry
 * journal TABLES with the manual-journal endpoint. Task 3.3 switches on
 * AUTOMATIC posting: PostingService calls JournalService.post() inside the
 * operational transaction (payments today; GRN/COGS once fx lands) so the
 * ledger goes live. Both are exported for the operational modules to use.
 */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [AccountsController, JournalEntriesController],
  providers: [ChartOfAccountsService, JournalService, PostingService],
  exports: [JournalService, PostingService],
})
export class AccountingModule {}
