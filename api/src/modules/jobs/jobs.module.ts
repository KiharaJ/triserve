import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

/**
 * JobsModule — Task 1.3 (§4.3/§5): the job lifecycle API (/api/v1/jobs).
 *
 * Depends on WorkflowModule (validate every state move), ApprovalsModule
 * (hold requires_approval edges), and AuditModule (semantic TRANSITION rows).
 */
@Module({
  imports: [AuthModule, WorkflowModule, ApprovalsModule, AuditModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
