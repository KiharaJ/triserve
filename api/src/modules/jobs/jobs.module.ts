import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { InventoryModule } from '../inventory/inventory.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { JobPartsController } from './job-parts.controller';
import { JobPartsService } from './job-parts.service';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { OperationsReportController } from './operations-report.controller';
import { OperationsReportService } from './operations-report.service';

/**
 * JobsModule — Task 1.3 (§4.3/§5): the job lifecycle API (/api/v1/jobs).
 *
 * Depends on WorkflowModule (validate every state move), ApprovalsModule
 * (hold requires_approval edges), and AuditModule (semantic TRANSITION rows).
 * Task 2.2 (§4.5) adds job parts, which reserve/consume stock through
 * InventoryModule's applyMovement — hence the InventoryModule import.
 */
@Module({
  imports: [
    AuthModule,
    WorkflowModule,
    ApprovalsModule,
    AuditModule,
    InventoryModule,
  ],
  controllers: [JobsController, JobPartsController, OperationsReportController],
  providers: [JobsService, JobPartsService, OperationsReportService],
  exports: [JobsService],
})
export class JobsModule {}
