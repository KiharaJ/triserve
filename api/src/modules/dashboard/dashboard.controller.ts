import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { DashboardService, type DashboardSummary } from './dashboard.service';

/**
 * /api/v1/dashboard (§8). Read-only operations roll-up for the home screen.
 * Any authenticated user may load it; the service scopes financials to the
 * caller's company (and to their branch when they are branch-scoped).
 */
@Controller('dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser): Promise<DashboardSummary> {
    return this.dashboard.summary(user);
  }
}
