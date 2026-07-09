import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { UsersModule } from './modules/users/users.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // .env in /api takes precedence; fall back to the repo-root .env.
      envFilePath: ['.env', '../.env'],
    }),
    PrismaModule,
    HealthModule,
    // Domain module skeletons (Task 0.0) — fleshed out by later tasks.
    AuthModule,
    CompaniesModule,
    BranchesModule,
    UsersModule,
    AuditModule,
    ApprovalsModule,
    AccountingModule,
  ],
})
export class AppModule {}
