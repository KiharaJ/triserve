import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { GspnBridgeService } from './gspn-bridge.service';
import { WarrantyClaimsController } from './warranty-claims.controller';
import { WarrantyClaimsService } from './warranty-claims.service';
import { WarrantyRegistrationsController } from './warranty-registrations.controller';
import { WarrantyRegistrationsService } from './warranty-registrations.service';

/**
 * WarrantyModule (Phase 4, §4.7 / E13) — the In-Warranty claim side. Task 4.1
 * lands claims CRUD; Task 4.2 adds the submit/reconcile lifecycle + AR–Samsung
 * postings (via AccountingModule's PostingService). Depends on AuditModule for
 * the semantic lifecycle rows.
 */
@Module({
  imports: [AuthModule, AuditModule, AccountingModule],
  controllers: [WarrantyClaimsController, WarrantyRegistrationsController],
  providers: [WarrantyClaimsService, GspnBridgeService, WarrantyRegistrationsService],
  exports: [WarrantyClaimsService],
})
export class WarrantyModule {}
