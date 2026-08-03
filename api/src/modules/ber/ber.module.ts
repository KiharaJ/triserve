import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { BerController } from './ber.controller';
import { BerService } from './ber.service';
import { SwapService } from './swap.service';

/**
 * BerModule (SCMS proposal Module 4, §5) — the Beyond-Economic-Repair
 * threshold, supervisor certification, the isolated Swap Buffer Stock, and
 * primary identity realignment.
 *
 * Exports SwapService so device history (E3) can walk the replacement chain:
 * a swapped IMEI must not read as a device with no past.
 */
@Module({
  imports: [AuthModule, AuditModule, ApprovalsModule, JobsModule],
  controllers: [BerController],
  providers: [BerService, SwapService],
  exports: [BerService, SwapService],
})
export class BerModule {}
