import { Prisma } from '@prisma/client';
import {
  getCurrentUser,
  getRequestMeta,
} from '../common/context/request-context';

/**
 * Audit-log Prisma client extension (Task 0.4, DESIGN.md §4.8).
 *
 * Intercepts create/update/upsert/delete/updateMany/deleteMany on every
 * AUDITED model and writes audit_log row(s) IN THE SAME TRANSACTION as the
 * mutation, capturing full before/after row snapshots. Actor, company, ip
 * and user_agent come from the AsyncLocalStorage request context (Task 0.3);
 * outside a request context (seed/system jobs on the DI client) the mutation
 * is still audited with actor_user_id = NULL.
 *
 * COMPOSITION (order matters — see PrismaService):
 *
 *     new PrismaClient()
 *       .$extends(companyScopeExtension)   // inner
 *       .$extends(auditExtension)          // outer
 *
 * This extension is defined with `Prisma.defineExtension((client) => ...)`,
 * so the closure captures the INNER client (company-scoped, but WITHOUT the
 * audit hook). Intercepted mutations are re-dispatched through
 * `client.$transaction(...)` on that inner client:
 *
 *   - NO RECURSION by construction: the re-dispatched mutation and the
 *     audit_log insert run on a client that simply does not have this hook —
 *     no re-entrancy flag needed.
 *   - Company scoping still applies: the before-read, the mutation and the
 *     audit insert all pass through companyScopeExtension on the tx client,
 *     so tenancy filters/injection behave exactly as in Task 0.3 (e.g. an
 *     out-of-scope update still fails with P2025, before any audit write).
 *   - ATOMIC: mutation + audit row commit or roll back together.
 *
 * KNOWN LIMITATIONS (documented tradeoff of same-transaction interception):
 *   - Audited mutations must NOT be wrapped in a caller-managed
 *     `$transaction` (interactive or batch array): the hook opens its own
 *     transaction on the inner client, which would escape the caller's tx
 *     (and the batch form requires PrismaPromise, which the hook no longer
 *     returns). No service does this today; when one needs to, use
 *     AuditService.record(...) inside its own tx instead.
 *   - `createMany` on audited models THROWS (fail closed): MySQL cannot
 *     return the created rows, so their after-state could not be captured.
 *     Use `create` in a loop (or the raw seed client, which bypasses the
 *     DI extensions entirely).
 *   - `$queryRaw`/`$executeRaw` are not intercepted — trusted system/report
 *     code only, per the Task 0.3 bypass rule.
 */

/**
 * Models whose mutations are audited. EXTEND THIS LIST as new tables arrive
 * (jobs, customers, parts, invoices, …).
 *
 * Deliberately EXCLUDED:
 *   - AuditLog — auditing the audit trail would recurse; instead it is
 *     guarded append-only below (any update/delete attempt throws).
 *   - Session  — auth infrastructure, high-churn (login/refresh/logout);
 *     login history IS the sessions table itself (Task 0.2).
 */
export const AUDITED_MODELS: ReadonlySet<Prisma.ModelName> = new Set([
  Prisma.ModelName.Company,
  Prisma.ModelName.Branch,
  Prisma.ModelName.User,
  Prisma.ModelName.Currency,
  Prisma.ModelName.PaymentMethod,
  Prisma.ModelName.FaultCode,
  Prisma.ModelName.RepairAction,
  Prisma.ModelName.TaxRate,
  // Task 0.5: approvals + rules are audited like any other model (CREATE on
  // request(), a mechanical UPDATE on decide()); ApprovalsService.decide()
  // ADDITIONALLY writes the semantic APPROVE/REJECT row via
  // AuditService.record().
  Prisma.ModelName.Approval,
  Prisma.ModelName.ApprovalRule,
]);

/** Mutations we intercept and audit. */
const AUDITED_OPERATIONS = new Set([
  'create',
  'update',
  'upsert',
  'delete',
  'updateMany',
  'deleteMany',
]);

/** Mutation ops that must never touch audit_log (append-only guarantee). */
const FORBIDDEN_AUDIT_LOG_OPERATIONS = new Set([
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/**
 * Secrets are REDACTED from snapshots — the audit trail must never become a
 * copy of credential material.
 */
const REDACTED_FIELDS = new Set([
  'passwordHash',
  'totpSecret',
  'refreshTokenHash',
]);

type Row = Record<string, unknown>;

/** Minimal structural typing for dynamic delegate dispatch inside the tx. */
interface Delegate {
  findUnique(args: unknown): Promise<Row | null>;
  findMany(args: unknown): Promise<Row[]>;
  create(args: unknown): Promise<Row>;
  update(args: unknown): Promise<Row>;
  upsert(args: unknown): Promise<Row>;
  delete(args: unknown): Promise<Row>;
  updateMany(args: unknown): Promise<{ count: number }>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}

interface TxLike {
  auditLog: { create(args: { data: Row }): Promise<Row> };
  [delegate: string]: unknown;
}

interface ClientLike {
  $transaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T>;
}

/** Prisma model name → delegate property, e.g. 'PaymentMethod' → 'paymentMethod'. */
function delegateKey(model: Prisma.ModelName): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function serializeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  return value;
}

/**
 * Full-row snapshot for before_json/after_json: scalar-only, JSON-safe
 * (BigInt/Decimal → string, Date → ISO-8601), secrets redacted.
 */
export function snapshotRow(row: Row): Prisma.InputJsonObject {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'object' && value !== null) {
      // Relation objects (from `include`) don't belong in a row snapshot;
      // Date/Decimal are handled by serializeValue below.
      if (!(value instanceof Date) && !(value instanceof Prisma.Decimal)) {
        continue;
      }
    }
    snapshot[key] = REDACTED_FIELDS.has(key)
      ? '[REDACTED]'
      : serializeValue(value);
  }
  return snapshot as Prisma.InputJsonObject;
}

/** Build one audit_log row. `state` = after ?? before (never both null). */
function buildAuditRow(
  model: Prisma.ModelName,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityId: string,
  before: Row | null,
  after: Row | null,
): Row {
  const user = getCurrentUser();
  const meta = getRequestMeta();
  const state = (after ?? before) as Row;

  // company_id: from the entity itself (Company rows ARE the tenant, keyed
  // by id) so system writes without a request context still attribute
  // correctly; the acting user's company is a fallback only.
  const companyId =
    model === Prisma.ModelName.Company
      ? entityId
      : ((state.companyId as string | undefined) ?? user?.companyId);

  // branch_id: entity's branch when it has one (Branch rows are their own
  // branch), else the acting user's home branch, else NULL.
  const branchId =
    (state.branchId as string | undefined) ??
    (model === Prisma.ModelName.Branch ? entityId : undefined) ??
    user?.homeBranchId ??
    null;

  return {
    companyId,
    branchId,
    actorUserId: user?.userId ?? null,
    entityType: model,
    entityId,
    action,
    ...(before ? { beforeJson: snapshotRow(before) } : {}),
    ...(after ? { afterJson: snapshotRow(after) } : {}),
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  };
}

async function writeAudit(
  tx: TxLike,
  model: Prisma.ModelName,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  entityId: string,
  before: Row | null,
  after: Row | null,
): Promise<void> {
  await tx.auditLog.create({
    data: buildAuditRow(model, action, entityId, before, after),
  });
}

/**
 * Extract `where` from dynamically typed operation args. Takes `unknown` on
 * purpose: inside the functional-form extension the args union is opaque to
 * the typed-lint program, and laundering it through an unknown parameter is
 * the one pattern both tsc and typed eslint accept without assertions.
 */
function whereOf(args: unknown): unknown {
  return (args as { where?: unknown } | null | undefined)?.where;
}

function entityIdOf(row: Row, model: Prisma.ModelName, operation: string) {
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) {
    // Fail closed: an audited mutation whose result hides `id` (e.g. a
    // `select` without it) cannot be attributed — reject inside the tx so
    // the mutation rolls back rather than going unaudited.
    throw new Error(
      `Audited ${model}.${operation} must return \`id\` (do not select it away)`,
    );
  }
  return id;
}

export const auditExtension = Prisma.defineExtension((client) => {
  // The inner client (company-scoped, WITHOUT this hook) — all re-dispatch
  // and audit writes go through it, which is what prevents recursion.
  const inner = client as unknown as ClientLike;

  return client.$extends({
    name: 'audit-log',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // --- audit_log itself: append-only, reads + create only ---------
          if (model === Prisma.ModelName.AuditLog) {
            if (FORBIDDEN_AUDIT_LOG_OPERATIONS.has(operation)) {
              throw new Error(
                `audit_log is append-only: ${operation} is not permitted`,
              );
            }
            return query(args);
          }

          if (!AUDITED_MODELS.has(model)) return query(args);

          if (!AUDITED_OPERATIONS.has(operation)) {
            if (operation === 'createMany') {
              throw new Error(
                `createMany on audited model ${model} cannot capture ` +
                  'after-state on MySQL — use create() per row',
              );
            }
            return query(args); // reads pass through untouched
          }

          const where = whereOf(args);
          const dk = delegateKey(model);

          // Mutation + before-read + audit insert: ONE transaction on the
          // inner client (company-scope applies inside; no audit recursion).
          return inner.$transaction(async (tx) => {
            const d = tx[dk] as Delegate;

            switch (operation) {
              case 'create': {
                const result = await d.create(args);
                const id = entityIdOf(result, model, operation);
                // Snapshot from a fresh full read so caller `select`/
                // `include` never truncates the audit record.
                const after = await d.findUnique({ where: { id } });
                await writeAudit(tx, model, 'CREATE', id, null, after);
                return result;
              }
              case 'update': {
                const before = await d.findUnique({ where });
                const result = await d.update(args); // P2025 if out of scope
                const id = entityIdOf(before ?? result, model, operation);
                const after = await d.findUnique({ where: { id } });
                await writeAudit(tx, model, 'UPDATE', id, before, after);
                return result;
              }
              case 'upsert': {
                const before = await d.findUnique({ where });
                const result = await d.upsert(args);
                const id = entityIdOf(before ?? result, model, operation);
                const after = await d.findUnique({ where: { id } });
                await writeAudit(
                  tx,
                  model,
                  before ? 'UPDATE' : 'CREATE',
                  id,
                  before,
                  after,
                );
                return result;
              }
              case 'delete': {
                const before = await d.findUnique({ where });
                const result = await d.delete(args);
                const id = entityIdOf(before ?? result, model, operation);
                await writeAudit(
                  tx,
                  model,
                  'DELETE',
                  id,
                  before ?? result,
                  null,
                );
                return result;
              }
              case 'updateMany': {
                const beforeRows = await d.findMany({ where });
                const result = await d.updateMany(args);
                const ids = beforeRows.map((r) => r.id as string);
                const afterRows = ids.length
                  ? await d.findMany({ where: { id: { in: ids } } })
                  : [];
                const afterById = new Map(
                  afterRows.map((r) => [r.id as string, r]),
                );
                for (const before of beforeRows) {
                  const id = before.id as string;
                  await writeAudit(
                    tx,
                    model,
                    'UPDATE',
                    id,
                    before,
                    afterById.get(id) ?? null,
                  );
                }
                return result;
              }
              case 'deleteMany': {
                const beforeRows = await d.findMany({ where });
                const result = await d.deleteMany(args);
                for (const before of beforeRows) {
                  await writeAudit(
                    tx,
                    model,
                    'DELETE',
                    before.id as string,
                    before,
                    null,
                  );
                }
                return result;
              }
              /* istanbul ignore next -- unreachable, set-guarded above */
              default:
                return query(args);
            }
          });
        },
      },
    },
  });
});
