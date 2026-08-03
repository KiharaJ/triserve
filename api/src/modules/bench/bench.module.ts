import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { JobsModule } from '../jobs/jobs.module';
import { BenchController } from './bench.controller';
import { QcService } from './qc.service';
import { SkillsService } from './skills.service';

/**
 * BenchModule (SCMS proposal Module 2, §3) — the technician skill matrix,
 * job routing, and the quality-control gate with its mandatory calibration
 * checklist.
 *
 * Exports SkillsService because the `engineer_skill_match` workflow guard's
 * sibling concern — "may this person sign QC off" — is asked from the QC
 * endpoints, and because routing suggestions are useful from the job board.
 */
@Module({
  imports: [AuthModule, AuditModule, JobsModule],
  controllers: [BenchController],
  providers: [SkillsService, QcService],
  exports: [SkillsService, QcService],
})
export class BenchModule {}
