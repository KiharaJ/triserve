import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CompaniesController } from './companies.controller';
import { CompaniesService } from './companies.service';

/**
 * CompaniesModule — Task 0.7: the caller's company profile
 * (GET/PATCH /api/v1/company) for the admin screens.
 */
@Module({
  imports: [AuthModule],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService],
})
export class CompaniesModule {}
