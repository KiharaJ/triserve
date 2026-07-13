import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  OperationsReportService,
  type OperationsReportWire,
} from './operations-report.service';

class RangeDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * GET /api/v1/reports/operations?from=&to= (Phase 5 / E15 + E5) — repair-shop
 * BI: intake trend, state mix, top models, per-branch load, technician
 * performance. Gated by job.read; branch users see their branch only.
 */
@Controller('reports')
@UseGuards(AuthGuard, PermissionsGuard)
export class OperationsReportController {
  constructor(private readonly ops: OperationsReportService) {}

  @Get('operations')
  @RequirePermissions('job.read')
  operations(
    @Query() q: RangeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<OperationsReportWire> {
    return this.ops.summary(user, q.from, q.to);
  }
}
