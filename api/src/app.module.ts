import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { HealthModule } from './health/health.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { ConfigTablesModule } from './modules/config-tables/config-tables.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DevicesModule } from './modules/devices/devices.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { ModelsModule } from './modules/models/models.module';
import { UsersModule } from './modules/users/users.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
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
    AuthModule,
    CompaniesModule,
    BranchesModule,
    UsersModule,
    ConfigTablesModule,
    AuditModule,
    ApprovalsModule,
    AccountingModule,
    CustomersModule,
    DevicesModule,
    ModelsModule,
    WorkflowModule,
    JobsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Enter the AsyncLocalStorage request context for EVERY route so the
    // Prisma company-scope extension can see the acting user (Task 0.3).
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
