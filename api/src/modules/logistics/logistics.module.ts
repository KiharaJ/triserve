import { Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { JobEventsService } from '../jobs/job-events.service';
import { JobsModule } from '../jobs/jobs.module';
import { CollectionOtpService } from './collection-otp.service';
import { ConsignmentsService } from './consignments.service';
import { CsatService } from './csat.service';
import { LogisticsController } from './logistics.controller';
import { PublicCsatController } from './public-csat.controller';

/**
 * LogisticsModule (SCMS proposal Module 6, §7) — the secure handover PIN, the
 * hub-and-spoke consignment chain with its chain-of-custody scans, and the
 * post-closure CSAT survey.
 *
 * Exports the OTP and CSAT services so JobsService can fire them from the
 * lifecycle: a PIN is issued the moment a job reaches READY, and a survey the
 * moment it is handed over. Both are consequences of a state change, not
 * things the counter should have to remember to do.
 */
@Module({
  imports: [AuthModule, AuditModule, ConfigModule, JobsModule],
  controllers: [LogisticsController, PublicCsatController],
  providers: [CollectionOtpService, ConsignmentsService, CsatService],
  exports: [CollectionOtpService, ConsignmentsService, CsatService],
})
export class LogisticsModule implements OnModuleInit {
  constructor(
    private readonly events: JobEventsService,
    private readonly otp: CollectionOtpService,
    private readonly csat: CsatService,
  ) {}

  /**
   * Subscribe to the job lifecycle (proposal §7 steps 1 and 5).
   *
   * Keyed on the STAGE, not the state code: a company that renames READY to
   * "Awaiting Collection" must still get a collection PIN, and a company that
   * adds its own terminal state must still get a survey.
   */
  onModuleInit(): void {
    this.events.onStateChanged('logistics:collection-otp', async (e) => {
      // §7 step 1: "When a job transitions to READY_FOR_COLLECTION, the system
      // generates a secure, randomized, single-use 6-digit One-Time PIN."
      if (e.toStage !== 'READY') return;
      await this.otp.issueOnReady({
        id: e.jobId,
        companyId: e.companyId,
        branchId: e.branchId,
      });
    });

    this.events.onStateChanged('logistics:csat', async (e) => {
      // §7 step 5: the survey fires on handover, not on every terminal state —
      // a cancelled or returned-unrepaired job has no repair to rate.
      if (e.toStateCode !== 'DISPATCHED') return;
      await this.csat.requestForJob(e.jobId);
    });
  }
}
