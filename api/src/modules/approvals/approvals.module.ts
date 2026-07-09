import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';

/**
 * ApprovalsModule — Task 0.5 (§4.11 / E8): the generic approvals framework.
 *
 * ONE mechanism gates every sensitive action. ApprovalsService is EXPORTED
 * so later domain modules (POS refunds/voids, inventory adjustments, POs,
 * job reopens, manual journals, …) import this module and call
 * `isRequired()` + `request()` before performing a gated action — see the
 * hook pattern documented on ApprovalsService. No domain action is wired
 * yet, by design.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
