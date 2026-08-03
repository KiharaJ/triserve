import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

/**
 * IntakeModule (SCMS proposal Module 1, §2) — the structured captures that
 * replace free text at the counter: the cascading symptom tree, the visual
 * condition map, and the digital agreement.
 *
 * Imports JobsModule for `loadAccessibleJob`, so a job reached through an
 * intake endpoint is scoped EXACTLY as it is everywhere else (company, branch,
 * and the technician-only visibility rule) rather than re-implementing that
 * check here and letting the two drift.
 */
@Module({
  imports: [AuthModule, AuditModule, JobsModule],
  controllers: [IntakeController],
  providers: [IntakeService],
  exports: [IntakeService],
})
export class IntakeModule {}
