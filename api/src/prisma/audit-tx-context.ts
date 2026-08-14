import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The caller-managed transaction currently in flight, carried on
 * AsyncLocalStorage so {@link auditExtension} can join it instead of opening
 * one of its own.
 *
 * WHY THIS EXISTS
 *
 * The audit hook intercepts a mutation and re-dispatches it, together with the
 * before-read and the audit_log insert, inside `inner.$transaction(...)`. That
 * is correct for the common case — a bare `prisma.job.update(...)` — but it is
 * a SEPARATE transaction on a SEPARATE connection. When the caller had already
 * opened its own interactive transaction, the two deadlock against each other:
 *
 *   1. the caller's tx inserts a child row (e.g. `job_state_events`), which
 *      takes a shared FK lock on the parent `jobs` row;
 *   2. the hook's tx tries to UPDATE that same `jobs` row and blocks on the
 *      exclusive lock;
 *   3. the caller's tx is awaiting the hook, so it can never release —
 *      Prisma's 5s interactive-transaction timeout fires and rolls the
 *      caller's work back, while the hook's tx goes on to commit.
 *
 * The result is a HALF-COMMITTED write: the audited row moves, everything the
 * caller did in its own transaction is lost, and the request 500s. This is
 * exactly the failure that stopped every job transition in production between
 * 2026-08-05 and 2026-08-14 — `jobs.state_id` advanced while the SLA clock
 * rows never landed.
 *
 * THE FIX: {@link PrismaService.$transaction} publishes its transaction client
 * here for the duration of the callback. The audit hook checks
 * {@link getAuditTx} first; when a caller transaction is in flight it runs the
 * before-read, the mutation and the audit insert on THAT client, so everything
 * commits or rolls back as one unit on one connection.
 *
 * KNOWN LIMITATION: the store says "a transaction is in flight on this async
 * chain", not "this particular query is running on it". Inside a
 * `$transaction` callback, always mutate through the `tx` handle the callback
 * was given. Reaching for the outer `this.prisma` instead would run the
 * mutation outside the transaction while its audit row lands inside it — the
 * two would then disagree if the transaction rolled back.
 */

/** Structural shape the hook needs: model delegates + an auditLog delegate. */
export interface AuditTxClient {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  [delegate: string]: unknown;
}

const storage = new AsyncLocalStorage<AuditTxClient>();

/** Run `fn` with `tx` published as the in-flight caller transaction. */
export function runWithAuditTx<T>(
  tx: AuditTxClient,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(tx, fn);
}

/** The caller transaction in flight, or undefined when there is none. */
export function getAuditTx(): AuditTxClient | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with NO transaction published. Used by the audit hook around its
 * own `inner.$transaction(...)`: that client has no audit hook, so nothing
 * downstream should mistake it for a caller transaction to join.
 */
export function runWithoutAuditTx<T>(fn: () => Promise<T>): Promise<T> {
  return storage.exit(fn);
}
