import { Prisma } from '@prisma/client';
import type { AuthUser } from '../modules/auth/auth.types';
import { getCurrentUser } from '../common/context/request-context';

/**
 * Company/branch scoping Prisma client extension (Task 0.3, DESIGN.md §3/§4).
 *
 * Every query against a company-scoped model is automatically filtered by
 * the acting user's `company_id` (and, for scope='branch' users, their home
 * branch where applicable), so a forgotten `where: { companyId }` in a
 * service can never leak cross-tenant data. Creates get `company_id` forced
 * to the acting user's company.
 *
 * BYPASS RULE (deliberate, documented): when there is no request context /
 * no authenticated user (seeds, migrations, system jobs, unauthenticated
 * routes like login, unit tests), NO scoping is applied — see the note on
 * `request-context.ts`. Trusted system code only.
 */

/**
 * Models carrying a `company_id` column, scoped by `companyId = user's`.
 * EXTEND THIS LIST as new tables arrive (jobs, customers, parts, …).
 * `Company` itself has no company_id — it is the tenant row, so it is
 * scoped by `id = user's companyId` instead (see {@link scopedWhere}).
 * `Session` is intentionally absent: scoped via its user, not a column.
 * `AuditLog` (Task 0.4) IS listed: reads through the endpoint are tenancy-
 * filtered, and in-context audit inserts get company_id pinned like any
 * other create (system inserts set it explicitly under the bypass rule).
 * `JournalLine` (Task 0.6) is intentionally absent: it has NO company_id
 * column, so this extension must never touch it (the injected filter would
 * be invalid). Lines are reached exclusively through their entry — either
 * `include: { lines }` on a scoped JournalEntry query or the nested create
 * inside JournalService.post() — so tenancy is enforced via the entry join.
 */
export const COMPANY_SCOPED_MODELS: ReadonlySet<Prisma.ModelName> = new Set([
  Prisma.ModelName.Company,
  Prisma.ModelName.User,
  Prisma.ModelName.Branch,
  Prisma.ModelName.Currency,
  Prisma.ModelName.PaymentMethod,
  Prisma.ModelName.FaultCode,
  Prisma.ModelName.RepairAction,
  Prisma.ModelName.TaxRate,
  Prisma.ModelName.AuditLog,
  Prisma.ModelName.Approval,
  Prisma.ModelName.ApprovalRule,
  // Task 0.6 (§4.9/E1): the ledger is company-scoped like everything else.
  Prisma.ModelName.ChartOfAccount,
  Prisma.ModelName.JournalEntry,
  // Task 1.1 (§4.2/E2/E3): CRM foundations.
  Prisma.ModelName.Customer,
  Prisma.ModelName.Device,
  Prisma.ModelName.DeviceModel,
  // Task 1.2 (§4.10/E7): the workflow engine is COMPANY-level config (like
  // fault codes) — every branch shares the company's board, so neither
  // model is branch-scoped.
  Prisma.ModelName.WorkflowState,
  Prisma.ModelName.WorkflowTransition,
  // Task 1.3 (§4.3): jobs are company- AND branch-scoped (see
  // BRANCH_SCOPED_MODELS below). JobCounter is listed for defense-in-depth,
  // but in practice it is only ever touched via raw SQL (which bypasses this
  // extension entirely) — its company_id is passed explicitly there.
  Prisma.ModelName.Job,
  Prisma.ModelName.JobCounter,
]);

/**
 * Models carrying a `branch_id` column: scope='branch' users are further
 * restricted to `branchId = homeBranchId`. Future tables (jobs,
 * stock_movements, invoices, …) register here as they arrive. The `Branch`
 * model itself is special-cased (restricted by `id`).
 *
 * `JournalEntry` is deliberately NOT branch-scoped even though it has a
 * (nullable) branch_id: the ledger is a company-level book (§4.9) — its
 * branch_id is an analytics dimension, and company-level entries carry
 * branch_id = NULL, which a branch filter would silently hide. Access is
 * instead gated by the finance permissions ('accounting.read'/'.post'),
 * which only ACCOUNTANT/SUPER_ADMIN hold by default.
 *
 * `Customer` / `Device` (Task 1.1, §4.2) are deliberately NOT branch-scoped:
 * a customer belongs to the COMPANY and can be served at any branch —
 * `customers.preferred_branch_id` is a CRM preference, not an access
 * boundary. Branch-scoping would hide a returning customer (and their
 * device history, E3) from every branch except the preferred one, breaking
 * the "front desk finds/creates customer by phone" flow (§6.1) group-wide.
 * `DeviceModel` is company-level config (like fault codes) — no branch_id.
 *
 * `Job` (Task 1.3, §4.3) IS branch-scoped: a job belongs to the branch that
 * received the device, and a scope='branch' user only sees their branch's
 * jobs. TECHNICIANs are restricted FURTHER (to jobs assigned to them) inside
 * JobsService — that is a per-user filter, not a tenancy boundary, so it
 * lives in the service rather than here.
 */
export const BRANCH_SCOPED_MODELS: ReadonlySet<Prisma.ModelName> = new Set([
  Prisma.ModelName.Approval,
  Prisma.ModelName.Job,
]);

/** Operations that accept a `where` filter we can tighten. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
  'upsert',
]);

type WhereInput = Record<string, unknown> & {
  AND?: unknown;
};

function normalizeAnd(and: unknown): unknown[] {
  if (and === undefined) return [];
  return Array.isArray(and) ? and : [and];
}

/**
 * Tighten `where` with tenancy clauses. Unique fields stay at the top level
 * (required by `*WhereUniqueInput`); extra clauses go into `AND`, which
 * Prisma 5+ accepts on unique lookups too (extendedWhereUnique, GA).
 */
function scopedWhere(
  model: Prisma.ModelName,
  where: WhereInput | undefined,
  user: AuthUser,
): WhereInput {
  // `companies` has no company_id column — it IS the tenant, keyed by id.
  const clauses: Record<string, unknown>[] =
    model === Prisma.ModelName.Company
      ? [{ id: user.companyId }]
      : [{ companyId: user.companyId }];

  if (user.scope === 'branch' && user.homeBranchId) {
    if (model === Prisma.ModelName.Branch) {
      // Branch rows have no branchId — restrict by primary key.
      clauses.push({ id: user.homeBranchId });
    } else if (BRANCH_SCOPED_MODELS.has(model)) {
      clauses.push({ branchId: user.homeBranchId });
    }
  }

  return {
    ...(where ?? {}),
    AND: [...normalizeAnd(where?.AND), ...clauses],
  };
}

/**
 * Force `company_id` on created rows. Services must use scalar FKs
 * ("unchecked" input, e.g. `homeBranchId: x`) when creating scoped rows: a
 * relation-object (`company: { connect: … }`) is stripped and replaced, and
 * mixing other relation objects with the injected scalar fails loudly at
 * Prisma validation — fail-closed, never cross-tenant.
 */
function forceCompanyId(
  data: Record<string, unknown>,
  user: AuthUser,
): Record<string, unknown> {
  const next = { ...data };
  delete next.company;
  next.companyId = user.companyId;
  return next;
}

export const companyScopeExtension = Prisma.defineExtension({
  name: 'company-scope',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        if (!COMPANY_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const user = getCurrentUser();
        if (!user) {
          // Documented bypass: no request context → system code → unscoped.
          return query(args);
        }

        const nextArgs = { ...(args ?? {}) } as Record<string, unknown>;

        if (WHERE_OPERATIONS.has(operation)) {
          nextArgs.where = scopedWhere(
            model,
            nextArgs.where as WhereInput | undefined,
            user,
          );
        }

        // `companies` rows have no company_id to inject on create; reads/
        // updates above are already pinned to id = user's companyId.
        if (model === Prisma.ModelName.Company) {
          return query(nextArgs);
        }

        if (operation === 'create') {
          nextArgs.data = forceCompanyId(
            nextArgs.data as Record<string, unknown>,
            user,
          );
        } else if (operation === 'createMany') {
          const data = nextArgs.data;
          nextArgs.data = Array.isArray(data)
            ? data.map((d: Record<string, unknown>) => forceCompanyId(d, user))
            : forceCompanyId(data as Record<string, unknown>, user);
        } else if (operation === 'upsert') {
          nextArgs.create = forceCompanyId(
            nextArgs.create as Record<string, unknown>,
            user,
          );
        }

        return query(nextArgs);
      },
    },
  },
});
