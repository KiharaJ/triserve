import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { HealthModule } from './health/health.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BenchModule } from './modules/bench/bench.module';
import { BerModule } from './modules/ber/ber.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { ConfigTablesModule } from './modules/config-tables/config-tables.module';
import { CustomersModule } from './modules/customers/customers.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DevicesModule } from './modules/devices/devices.module';
import { IntakeModule } from './modules/intake/intake.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LogisticsModule } from './modules/logistics/logistics.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PosModule } from './modules/pos/pos.module';
import { ProductsModule } from './modules/products/products.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { ModelsModule } from './modules/models/models.module';
import { PermissionResolverModule } from './modules/roles/permission-resolver.module';
import { RolesModule } from './modules/roles/roles.module';
import { SlaModule } from './modules/sla/sla.module';
import { UsersModule } from './modules/users/users.module';
import { WarrantyModule } from './modules/warranty/warranty.module';
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
    // E17: global resolver of the effective role × permission matrix — must be
    // available to the guard across every feature module.
    PermissionResolverModule,
    // SCMS proposal Module 2: the job clocks (CTD/HFP/TAT + pause-aware SLA).
    // GLOBAL — every path that changes a job's state must record an entry, and
    // the guarantee is that there is no way around it.
    SlaModule,
    // SCMS proposal Module 7 / §4.13: the notification engine and its
    // asynchronous outbox worker. GLOBAL — nearly every operational module
    // publishes events to it.
    NotificationsModule,
    HealthModule,
    AuthModule,
    CompaniesModule,
    BranchesModule,
    UsersModule,
    RolesModule,
    ConfigTablesModule,
    AuditModule,
    ApprovalsModule,
    AccountingModule,
    CustomersModule,
    DevicesModule,
    ModelsModule,
    WorkflowModule,
    JobsModule,
    AttachmentsModule,
    InventoryModule,
    SuppliersModule,
    ProcurementModule,
    PosModule,
    WarrantyModule,
    ProductsModule,
    DashboardModule,
    // -- SCMS proposal modules (Service_Center_System_Proposal.docx) --------
    // Module 1 (§2): symptom tree, condition map, intake evidence gate.
    IntakeModule,
    // Module 2 (§3): skill matrix, routing, QC calibration gate.
    BenchModule,
    // Module 4 (§5): BER threshold, certification, swap buffer stock.
    BerModule,
    // Module 6 (§7): collection PIN, consignment totes, chain of custody, CSAT.
    LogisticsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Enter the AsyncLocalStorage request context for EVERY route so the
    // Prisma company-scope extension can see the acting user (Task 0.3).
    consumer.apply(RequestContextMiddleware).forRoutes('{*splat}');
  }
}
