import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * DashboardModule (§8) — server-side analytics roll-up for the home screen.
 * Depends on AuthModule for the guard; reads across payments/jobs/inventory.
 */
@Module({
  imports: [AuthModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
