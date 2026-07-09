import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { auditExtension } from './audit.extension';
import { companyScopeExtension } from './company-scope.extension';

/**
 * PrismaClient with the company/branch scoping extension (Task 0.3) AND the
 * audit-log extension (Task 0.4) applied.
 *
 * The constructor returns the extended proxy in place of the bare client,
 * so EVERY injection of PrismaService is tenancy-scoped and audited by
 * default — a service cannot forget to use the "scoped" client because
 * there is no unscoped one in the DI container. (The extension proxy falls
 * through to this class's prototype, so lifecycle hooks and the public
 * PrismaClient surface — $queryRaw, $transaction, model delegates — all
 * keep working; result types are unchanged since the extensions only
 * tighten `where`/`data` args and add side-effect writes.)
 *
 * ORDER MATTERS: companyScopeExtension first (inner), auditExtension second
 * (outer). The audit hook re-dispatches mutations through the inner
 * (company-scoped, audit-free) client in one transaction — see
 * audit.extension.ts for why this composes without recursion.
 *
 * Scoping bypass for system code (seeds, no-context tests) is documented in
 * company-scope.extension.ts / request-context.ts.
 *
 * Connects lazily (on first query) so the API can boot without a database —
 * the health endpoint reports DB connectivity separately.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super();
    return this.$extends(companyScopeExtension).$extends(
      auditExtension,
    ) as unknown as this;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
