import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';

/**
 * WorkflowModule — Task 1.2 (§4.10/E7): the configurable workflow engine.
 * Exposes /api/v1/workflow/* config endpoints and exports WorkflowService
 * so the job lifecycle (Task 1.3) can validate every status move through
 * assertTransition().
 */
@Module({
  imports: [AuthModule],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowModule {}
