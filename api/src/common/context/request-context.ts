import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthUser } from '../../modules/auth/auth.types';

/**
 * Per-request context (Task 0.3) carried on AsyncLocalStorage so services
 * and the Prisma company-scope extension can read "who is acting" without
 * threading the user through every call.
 *
 * Lifecycle:
 *   1. {@link RequestContextMiddleware} enters a fresh (empty) store for
 *      every HTTP request, BEFORE guards run.
 *   2. AuthGuard authenticates and calls {@link setCurrentUser}.
 *   3. Anything downstream (services, Prisma extension) reads
 *      {@link getCurrentUser}.
 *
 * SCOPING BYPASS (deliberate, documented): code running with NO store —
 * seeds, migrations, cron/system jobs, unit tests that never entered a
 * context — sees `getCurrentUser() === undefined` and the Prisma extension
 * applies NO tenancy filters. Any such code path is trusted system code by
 * definition; never expose it to request-controlled input. HTTP requests
 * always have a store (middleware is global), and unauthenticated routes
 * simply have no user yet.
 */
export interface RequestContextStore {
  user?: AuthUser;
  /** Client IP (Express `req.ip`), set by the middleware (Task 0.4). */
  ip?: string;
  /** Raw User-Agent header, set by the middleware (Task 0.4). */
  userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/** Run `fn` inside a request context (used by middleware and tests). */
export function runWithRequestContext<T>(
  store: RequestContextStore,
  fn: () => T,
): T {
  return storage.run(store, fn);
}

/** The current store, or undefined outside any request context. */
export function getRequestContext(): RequestContextStore | undefined {
  return storage.getStore();
}

/** The authenticated user for this request, or undefined (see bypass note). */
export function getCurrentUser(): AuthUser | undefined {
  return storage.getStore()?.user;
}

/**
 * Request network metadata for audit rows (Task 0.4). Both fields are
 * undefined outside an HTTP request (system/seed code).
 */
export function getRequestMeta(): { ip?: string; userAgent?: string } {
  const store = storage.getStore();
  return { ip: store?.ip, userAgent: store?.userAgent };
}

/**
 * Attach the authenticated user to the current store (called by AuthGuard).
 * No-op when there is no store (e.g. guard exercised in a bare unit test).
 */
export function setCurrentUser(user: AuthUser): void {
  const store = storage.getStore();
  if (store) store.user = user;
}
