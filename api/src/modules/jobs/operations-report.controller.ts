import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsISO8601, IsOptional } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  FloorSnapshotService,
  type FloorSnapshotWire,
} from './floor-snapshot.service';
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
  constructor(
    private readonly ops: OperationsReportService,
    private readonly floor: FloorSnapshotService,
  ) {}

  /**
   * GET /reports/snapshot — the centre RIGHT NOW: what is overdue, due today,
   * unassigned or stale, where open work is sitting, and who is carrying it.
   *
   * No date range on purpose. This answers "what needs attention", which the
   * operations report (historical BI over a range) cannot.
   */
  @Get('snapshot')
  @RequirePermissions('job.read')
  snapshot(@CurrentUser() user: AuthUser): Promise<FloorSnapshotWire> {
    return this.floor.snapshot(user);
  }

  @Get('operations')
  @RequirePermissions('job.read')
  operations(
    @Query() q: RangeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<OperationsReportWire> {
    return this.ops.summary(user, q.from, q.to);
  }
}
