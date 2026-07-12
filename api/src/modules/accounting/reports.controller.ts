import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  ReportsService,
  type ProfitLossWire,
  type TrialBalanceWire,
} from './reports.service';

/** GET /reports/*?from=YYYY-MM-DD&to=YYYY-MM-DD (both optional). */
class ReportRangeDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * /api/v1/reports (Phase 5 / E1) — financial statements off the live ledger.
 *
 *   GET /reports/trial-balance?from=&to=   'accounting.read'
 *   GET /reports/profit-loss?from=&to=     'accounting.read'
 *
 * Both grouped by currency (TZS + USD are never summed without fx). Gated by
 * accounting.read (ACCOUNTANT / SUPER_ADMIN by default).
 */
@Controller('reports')
@UseGuards(AuthGuard, PermissionsGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('trial-balance')
  @RequirePermissions('accounting.read')
  trialBalance(
    @Query() q: ReportRangeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TrialBalanceWire> {
    return this.reports.trialBalance(user, q.from, q.to);
  }

  @Get('profit-loss')
  @RequirePermissions('accounting.read')
  profitLoss(
    @Query() q: ReportRangeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ProfitLossWire> {
    return this.reports.profitLoss(user, q.from, q.to);
  }
}
