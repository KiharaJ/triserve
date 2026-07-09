import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { companyScopeExtension } from './company-scope.extension';

/**
 * PrismaClient with the company/branch scoping extension applied (Task 0.3).
 *
 * The constructor returns the `$extends(companyScopeExtension)` proxy in
 * place of the bare client, so EVERY injection of PrismaService is tenancy-
 * scoped by default — a service cannot forget to use the "scoped" client
 * because there is no unscoped one in the DI container. (The extension
 * proxy falls through to this class's prototype, so lifecycle hooks and the
 * public PrismaClient surface — $queryRaw, $transaction, model delegates —
 * all keep working; result types are unchanged since the extension only
 * tightens `where`/`data` args.)
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
    return this.$extends(companyScopeExtension) as unknown as this;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
