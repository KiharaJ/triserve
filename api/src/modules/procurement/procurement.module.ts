import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { GrnController } from './grn.controller';
import { GrnService } from './grn.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * ProcurementModule — Tasks 2.6/2.7 (§4.4b): purchase orders + goods received
 * notes. Depends on ApprovalsModule (PO threshold gating), AuditModule
 * (semantic lifecycle rows) and InventoryModule (GRN receiving moves stock
 * through applyMovement).
 */
@Module({
  imports: [AuthModule, ApprovalsModule, AuditModule, InventoryModule],
  controllers: [PurchaseOrdersController, GrnController],
  providers: [PurchaseOrdersService, GrnService],
  exports: [PurchaseOrdersService, GrnService],
})
export class ProcurementModule {}
