import type { JobCoverage } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AuthUser } from '../../auth/auth.types';

/**
 * Workflow guard registry (Task 1.2, DESIGN.md §4.10/E7).
 *
 * `workflow_transitions.guard_code` names a business-rule predicate that
 * must hold for the edge to be taken — e.g. "OW quote approved before
 * IN_REPAIR", "balance paid before DISPATCHED". Guards live HERE, in code,
 * keyed by that string, so new rules plug in WITHOUT any schema change:
 * add a function to {@link WORKFLOW_GUARDS}, point an edge's `guard_code`
 * at it, done.
 *
 * WorkflowService.canTransition() consults the guard when the edge carries
 * a guard_code. An edge naming a guard that is NOT registered fails CLOSED
 * (transition denied) — a typo in config must never open a locked door.
 */

/** The job facts a guard may read. Structural, so any job row satisfies it. */
export interface JobGuardView {
  id: string;
  companyId: string;
  coverage: JobCoverage;
}

/**
 * Everything a guard may inspect. `job` is the job being transitioned;
 * `prisma` lets a guard check related state (invoices, payments, parts) that
 * the job row alone cannot answer. Callers can attach any extra facts —
 * guards MUST treat missing context as "not satisfied".
 */
export interface WorkflowGuardContext {
  companyId: string;
  user: AuthUser;
  /** Repository handle for guards that must look beyond the job row. */
  prisma: PrismaService;
  /** The job being transitioned. */
  job?: JobGuardView;
  /** Extra facts future callers attach (quote, invoice, balance, …). */
  [key: string]: unknown;
}

/**
 * A guard predicate: true = edge may be taken. Must not throw.
 *
 * Async because a guard's question is rarely answerable from the job row
 * alone — `ow_quote_approved` has to ask whether a quote exists at all.
 */
export type WorkflowGuard = (
  ctx: WorkflowGuardContext,
) => boolean | Promise<boolean>;

/**
 * Has the customer been quoted for the part of this repair THEY pay for?
 *
 * Job-card T&C 5 and 9: work not covered by warranty is quoted first and
 * settled C.O.D. — so a job where the customer bears cost must not reach
 * IN_REPAIR on a verbal nod. The gate keys off `coverage` (the billing
 * consequence), never `warrantyStatus`:
 *
 *   FULL         → Samsung/the shop pays everything. Nothing to quote; pass.
 *                  (GOODWILL repairs resolve to FULL, so they pass too.)
 *   LABOUR_ONLY  → customer still pays parts   → quote required.
 *   PARTS_ONLY   → customer still pays labour  → quote required.
 *   NONE         → customer pays it all        → quote required.
 *
 * There is no separate quote entity: a REPAIR_OW invoice on the job IS the
 * quote (DRAFT while pending, PARTIAL/PAID once money moves). VOID ones are
 * withdrawn quotes and do not count. Absent job context the guard fails
 * closed — an unknown job is not an approved one.
 */
const owQuoteApproved: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return false;
  if (job.coverage === 'FULL') return true;

  const quote = await prisma.invoice.findFirst({
    where: {
      jobId: job.id,
      type: 'REPAIR_OW',
      status: { not: 'VOID' },
      deletedAt: null,
    },
    select: { id: true },
  });
  return quote !== null;
};

/** guard_code → predicate. */
export const WORKFLOW_GUARDS: Readonly<Record<string, WorkflowGuard>> = {
  ow_quote_approved: owQuoteApproved,
};
