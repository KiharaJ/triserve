import { Prisma } from '@prisma/client';
import {
  getCurrentUser,
  getRequestMeta,
} from '../common/context/request-context';
import {
  getAuditTx,
  runWithoutAuditTx,
  type AuditTxClient,
} from './audit-tx-context';

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
 * CALLER-MANAGED TRANSACTIONS: an audited mutation inside
 * `PrismaService.$transaction(...)` JOINS the caller's transaction instead of
 * opening its own — {@link PrismaService.$transaction} publishes its tx client
 * on AsyncLocalStorage and the hook picks it up via `getAuditTx()`. Mutation,
 * before-read and audit row then commit or roll back as one unit on one
 * connection. Always mutate through the `tx` handle the callback was given;
 * see audit-tx-context.ts for why, and for the deadlock this replaced.
 *
 * KNOWN LIMITATIONS (documented tradeoff of same-transaction interception):
 *   - The BATCH array form of `$transaction([...])` still cannot carry an
 *     audited mutation: it requires PrismaPromise, which the hook does not
 *     return. Use the interactive callback form.
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
  // E17: changing a role's permissions reshapes what every holder of that role
  // can do — audited like the other access-control tables. Writes are simple
  // create/update/delete (never createMany, never a caller-managed tx).
  Prisma.ModelName.RolePermission,
  // E17b: creating/renaming/deleting a role is an access-control change — audited.
  Prisma.ModelName.Role,
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
  // Task 0.6 (§4.9/E1): the ledger is audited. JournalService.post() creates
  // the entry WITH its lines in ONE nested `journalEntry.create`, which this
  // hook wraps in one transaction (entry + lines + audit row are atomic) and
  // records as a single CREATE on the entry. JournalLine itself is NOT
  // listed: lines are immutable children written only through that nested
  // create (never as top-level mutations), and per-line audit rows would
  // only duplicate the entry-level trail.
  Prisma.ModelName.ChartOfAccount,
  Prisma.ModelName.JournalEntry,
  // Task 1.1 (§4.2): CRM foundations — customer/device/model mutations are
  // audited like every other business table.
  Prisma.ModelName.Customer,
  Prisma.ModelName.Device,
  Prisma.ModelName.DeviceModel,
  // Task 1.2 (§4.10/E7): workflow config changes reshape every job's legal
  // moves — audited like the other config tables.
  Prisma.ModelName.WorkflowState,
  Prisma.ModelName.WorkflowTransition,
  // Task 1.3 (§4.3): jobs are audited like every business table. Plain
  // create/patch record CREATE/UPDATE automatically; a state move ALSO emits
  // a semantic TRANSITION row via AuditService.record() (the extension only
  // sees the mechanical UPDATE). JobCounter is NOT listed — it is an internal
  // sequence written via raw SQL, not business data.
  Prisma.ModelName.Job,
  // Task 1.4 (§4.12/E4): attachments are audited like every business table.
  // Upload emits a CREATE row (full snapshot incl. the storage key); DELETE
  // is a REAL delete (no soft-delete column) so the audit DELETE row IS the
  // historical record that a file + its metadata once existed.
  Prisma.ModelName.Attachment,
  // Task 2.1 (§4.4): the parts CATALOGUE is audited like models — infrequent
  // edits, never written inside a caller-managed transaction. `Inventory` and
  // `StockMovement` are DELIBERATELY EXCLUDED: the append-only stock_movements
  // ledger IS inventory's audit trail (every bucket change carries
  // moved_by/moved_at/reason), and both are written together inside
  // InventoryService.applyMovement()'s own transaction — auditing them here
  // would violate this extension's "no caller-managed transaction" rule (see
  // KNOWN LIMITATIONS above), exactly like journal_lines.
  Prisma.ModelName.Part,
  // Task 2.5 (§4.4b): suppliers are audited like the parts catalogue —
  // infrequent config edits, never written inside a caller transaction.
  Prisma.ModelName.Supplier,
  // Task 2.4 (§4.4/E11): serial units are audited — each is a tracked,
  // high-value asset (register/status change/installation), never mutated
  // inside a caller-managed transaction.
  Prisma.ModelName.PartUnit,

  // -- SCMS proposal modules -------------------------------------------------
  // Module 1/2: the symptom tree, condition-map layout, skill matrix and QC
  // checklist are ACCESS- and QUALITY-critical config — changing who is
  // certified for a device class, or removing a blocking calibration check,
  // alters what the workflow guards will let through. Audited like roles.
  Prisma.ModelName.SymptomNode,
  Prisma.ModelName.ConditionZone,
  Prisma.ModelName.UserSkill,
  Prisma.ModelName.QcChecklistItem,
  // Module 1/2: the evidence itself. Condition marks are the record that
  // settles a damage dispute; QC checks are the record that a calibration was
  // performed. Both are written as ordinary creates outside any caller-managed
  // transaction, so the extension can capture them.
  Prisma.ModelName.JobConditionMark,
  Prisma.ModelName.JobQcCheck,
  // Module 4: certifying a device Beyond Economic Repair writes off a repair
  // and can commit a replacement unit — among the most consequential single
  // decisions in the system. Swap units and swaps are tracked assets and
  // identity changes respectively.
  Prisma.ModelName.BerAssessment,
  Prisma.ModelName.SwapUnit,
  Prisma.ModelName.DeviceSwap,
  // Module 5: a role's financial ceiling is an access-control change.
  Prisma.ModelName.RoleLimit,
  // Module 6: the consignment chain is custody of other people's property.
  // ConsignmentScan is deliberately ABSENT: it is append-only by construction
  // (never updated or deleted), so it IS its own audit trail — a second copy
  // of every scan would double the write volume for no added evidence.
  Prisma.ModelName.Consignment,
  Prisma.ModelName.ConsignmentJob,
  // Module 7: template edits change what customers are told.
  Prisma.ModelName.NotificationTemplate,
]);

/**
 * DELIBERATELY NOT AUDITED, and why:
 *
 *   JobStateEvent      — IS the state-change audit trail (append-only, with
 *                        actor and timestamps). JobsService additionally emits
 *                        a semantic TRANSITION row.
 *   JobCollectionOtp   — append-only in practice and holds a code hash; the
 *                        issue/verify/void stamps on the row are the trail.
 *   Notification       — the outbox row IS the comms log, and the worker
 *                        updates it several times per delivery; auditing every
 *                        status hop would bury the log in noise.
 *   ConsignmentScan    — append-only by construction (see above).
 *   *Counter models    — internal sequences written via raw SQL, not business
 *                        data (same reasoning as JobCounter).
 */

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

/**
 * Run the audit bookkeeping for one mutation ON AN EXISTING transaction.
 *
 * Mirrors the per-operation logic of the self-managed path below, with two
 * differences: the mutation itself is performed by `mutate()` (the hook's own
 * `query(args)`, which runs on the caller's transaction without re-entering
 * this hook), and the before/after reads plus the audit insert go through the
 * caller's tx client. Reads are not audited operations, so they pass straight
 * through the hook untouched — no recursion.
 */
async function auditOnTx(
  tx: AuditTxClient,
  p: {
    model: Prisma.ModelName;
    operation: string;
    args: unknown;
    where: unknown;
    dk: string;
    mutate: () => Promise<Row>;
  },
): Promise<unknown> {
  const { model, operation, where } = p;
  const d = tx[p.dk] as Delegate;
  const txLike = tx as unknown as TxLike;

  switch (operation) {
    case 'create': {
      const result = await p.mutate();
      const id = entityIdOf(result, model, operation);
      const after = await d.findUnique({ where: { id } });
      await writeAudit(txLike, model, 'CREATE', id, null, after);
      return result;
    }
    case 'update': {
      const before = await d.findUnique({ where });
      const result = await p.mutate(); // P2025 if out of scope
      const id = entityIdOf(before ?? result, model, operation);
      const after = await d.findUnique({ where: { id } });
      await writeAudit(txLike, model, 'UPDATE', id, before, after);
      return result;
    }
    case 'upsert': {
      const before = await d.findUnique({ where });
      const result = await p.mutate();
      const id = entityIdOf(before ?? result, model, operation);
      const after = await d.findUnique({ where: { id } });
      await writeAudit(
        txLike,
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
      const result = await p.mutate();
      const id = entityIdOf(before ?? result, model, operation);
      await writeAudit(txLike, model, 'DELETE', id, before ?? result, null);
      return result;
    }
    case 'updateMany': {
      const beforeRows = await d.findMany({ where });
      const result = await p.mutate();
      const ids = beforeRows.map((r) => r.id as string);
      const afterRows = ids.length
        ? await d.findMany({ where: { id: { in: ids } } })
        : [];
      const afterById = new Map(afterRows.map((r) => [r.id as string, r]));
      for (const before of beforeRows) {
        const id = before.id as string;
        await writeAudit(
          txLike,
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
      const result = await p.mutate();
      for (const before of beforeRows) {
        await writeAudit(
          txLike,
          model,
          'DELETE',
          before.id as string,
          before,
          null,
        );
      }
      return result;
    }
    /* istanbul ignore next -- unreachable, set-guarded by the caller */
    default:
      return p.mutate();
  }
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

          // A caller-managed transaction is already in flight: JOIN it rather
          // than opening a second one on another connection. Opening our own
          // here deadlocks against the caller's locks and half-commits the
          // write — see audit-tx-context.ts for the full mechanism.
          const callerTx = getAuditTx();
          if (callerTx) {
            // `query(args)` performs the mutation on the caller's transaction
            // WITHOUT re-entering this hook; the reads and the audit insert go
            // through the same tx client, so all of it is one unit of work.
            return auditOnTx(callerTx, {
              model,
              operation,
              args,
              where,
              dk,
              mutate: () => query(args) as Promise<Row>,
            });
          }

          // Mutation + before-read + audit insert: ONE transaction on the
          // inner client (company-scope applies inside; no audit recursion).
          // `runWithoutAuditTx` keeps this tx private to the hook — it must
          // never be mistaken for a caller transaction by a nested call.
          return runWithoutAuditTx(() =>
            inner.$transaction(async (tx) => {
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
            }),
          );
        },
      },
    },
  });
});
