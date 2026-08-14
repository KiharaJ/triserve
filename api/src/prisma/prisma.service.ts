import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { runWithAuditTx, type AuditTxClient } from './audit-tx-context';
import { auditExtension } from './audit.extension';
import { companyScopeExtension } from './company-scope.extension';

/** The interactive-callback form of `$transaction`. */
type InteractiveTx = (
  fn: (tx: unknown) => Promise<unknown>,
  options?: unknown,
) => Promise<unknown>;

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
 * `$transaction` IS WRAPPED (interactive form only) to publish its transaction
 * client on AsyncLocalStorage. That lets the audit hook JOIN a caller-managed
 * transaction rather than opening a second one on another connection, which
 * used to deadlock and half-commit the write — see audit-tx-context.ts. The
 * batch array form is passed through untouched (it cannot carry an audited
 * mutation anyway).
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
    const extended = this.$extends(companyScopeExtension).$extends(
      auditExtension,
    );

    // Bound BEFORE the proxy below, so the wrapper calls the real
    // implementation instead of recursing into itself.
    const original = (extended.$transaction as unknown as InteractiveTx).bind(
      extended,
    );

    const wrapped: InteractiveTx = (fn, options) => {
      // Batch array form: pass through — `fn` is an array of PrismaPromise,
      // not a callback, and no audited mutation can appear in one.
      if (typeof fn !== 'function') {
        return original(fn, options);
      }
      return original(
        (tx) => runWithAuditTx(tx as AuditTxClient, () => fn(tx)),
        options,
      );
    };

    return new Proxy(extended, {
      get(target, prop, receiver) {
        if (prop === '$transaction') return wrapped;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as this;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
