import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PartsController } from './parts.controller';
import { PartsService } from './parts.service';
import { PartUnitsController } from './part-units.controller';
import { PartUnitsService } from './part-units.service';
import { ReorderController } from './reorder.controller';
import { ReorderService } from './reorder.service';
import { StockTransferController } from './stock-transfer.controller';
import { StockTransferService } from './stock-transfer.service';

/**
 * InventoryModule — Task 2.1 (§4.4/E10): the parts catalogue + ledger-backed
 * stock API (/api/v1/parts, /api/v1/inventory), plus inter-branch transfers
 * (Task 2.3, /api/v1/transfers).
 *
 * Depends on ApprovalsModule (adjust/count/transfer-dispatch are approval-gated
 * by value). InventoryService is exported so later Phase-2/3 tasks (job
 * consumption, GRN receipts, POS sales) call applyMovement() — the single
 * stock write path — to move stock atomically.
 */
@Module({
  imports: [AuthModule, ApprovalsModule],
  controllers: [
    PartsController,
    InventoryController,
    StockTransferController,
    ReorderController,
    PartUnitsController,
  ],
  providers: [
    PartsService,
    InventoryService,
    StockTransferService,
    ReorderService,
    PartUnitsService,
  ],
  exports: [PartsService, InventoryService],
})
export class InventoryModule {}
