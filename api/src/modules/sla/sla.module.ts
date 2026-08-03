import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JobClockService } from './job-clock.service';
import { SlaController } from './sla.controller';

/**
 * SlaModule (SCMS proposal Module 2) — the job clocks.
 *
 * GLOBAL because {@link JobClockService.recordEntry} must be callable from
 * anywhere a job's state changes, and the whole guarantee of the state log is
 * that there is no path around it. Making every such module import this one
 * would be the same wiring expressed less safely.
 *
 * The reporting endpoints ship here too (the queue and the per-engineer KPI
 * aggregates) because they are pure reads over the clock — there is nothing of
 * the job lifecycle in them.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [SlaController],
  providers: [JobClockService],
  exports: [JobClockService],
})
export class SlaModule {}
