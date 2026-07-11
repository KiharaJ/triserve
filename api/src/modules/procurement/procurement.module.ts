import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';

/**
 * ProcurementModule — Task 2.6 (§4.4b): purchase orders (/api/v1/
 * purchase-orders). Depends on ApprovalsModule (threshold gating on submit)
 * and AuditModule (semantic lifecycle audit rows). Exports the PO service so
 * GRN receiving (Task 2.7) can post against orders.
 */
@Module({
  imports: [AuthModule, ApprovalsModule, AuditModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class ProcurementModule {}
