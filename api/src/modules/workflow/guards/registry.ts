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

/**
 * Everything a guard may inspect. `job` is the job row once Task 1.3 lands
 * (jobs table); callers can attach any extra facts (quote, invoice, …) —
 * guards must treat missing context as "not satisfied" when they go real.
 */
export interface WorkflowGuardContext {
  companyId: string;
  user: AuthUser;
  /** The job being transitioned (Task 1.3+). */
  job?: unknown;
  /** Extra facts future callers attach (quote, invoice, balance, …). */
  [key: string]: unknown;
}

/** A guard predicate: true = edge may be taken. Must not throw. */
export type WorkflowGuard = (ctx: WorkflowGuardContext) => boolean;

/**
 * guard_code → predicate.
 *
 * 'ow_quote_approved' is a PLACEHOLDER stub: it always passes today so the
 * default AWAITING_CUSTOMER_APPROVAL→IN_REPAIR edge stays usable. It is
 * wired for real in the POS phase (§6.2): check the job's OW quote is
 * customer-approved (and deposit taken where configured) before repair.
 */
export const WORKFLOW_GUARDS: Readonly<Record<string, WorkflowGuard>> = {
  ow_quote_approved: (): boolean => true,
};
