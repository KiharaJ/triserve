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
 *
 * These are the SCMS proposal's "Conditional Enforcements" column (§3) made
 * executable, plus §4 step 4's defective-return interlock and §6's
 * out-of-warranty financial gate.
 */

/** The job facts a guard may read. Structural, so any job row satisfies it. */
export interface JobGuardView {
  id: string;
  companyId: string;
  coverage: JobCoverage;
  /** Present from Task 1.3's job loader; guards must tolerate absence. */
  branchId?: string;
  assignedEngineerId?: string | null;
  deviceId?: string;
  techReport?: string | null;
  labourHours?: unknown;
  qcFailureReason?: string | null;
  qcRejectCount?: number;
  conditionCapturedAt?: Date | null;
  termsAcceptedAt?: Date | null;
  symptomNodeId?: string | null;
  techLocked?: boolean;
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
 * A guard's answer. A bare `true`/`false` is still accepted (and is what the
 * original guards returned); returning `{ ok: false, reason }` lets a guard
 * say WHICH condition failed, which matters once a single edge is gated on
 * several things at once — "not satisfied" is useless to a technician staring
 * at a job that will not move.
 */
export type GuardVerdict = boolean | { ok: boolean; reason?: string };

/** A guard predicate: true = edge may be taken. Must not throw. */
export type WorkflowGuard = (
  ctx: WorkflowGuardContext,
) => GuardVerdict | Promise<GuardVerdict>;

/** Normalize either verdict shape into `{ ok, reason }`. */
export function normalizeVerdict(v: GuardVerdict): {
  ok: boolean;
  reason?: string;
} {
  return typeof v === 'boolean' ? { ok: v } : v;
}

/** Deny with an explanation — the shape most guards below return. */
const deny = (reason: string): GuardVerdict => ({ ok: false, reason });
const ALLOW: GuardVerdict = { ok: true };

// ---------------------------------------------------------------------------
// Module 1 (§2) — intake integrity
// ---------------------------------------------------------------------------

/**
 * Has the counter done its job before the device leaves the front desk?
 *
 * The proposal is blunt about why this gate exists: "The intake process
 * dictates system data integrity. If weak, inconsistent, or unverified
 * information is entered at the counter, downstream operations will instantly
 * fragment." So RECEIVED → DIAGNOSING requires:
 *
 *   - the visual condition map was walked (§2 step 3),
 *   - a symptom-tree LEAF was picked, not free text (§2 step 4),
 *   - the customer agreed to the terms, and something evidencing that is on
 *     file (§2 step 5) — a real signature, or the recorded-agreement
 *     attestation when the customer could not physically sign.
 *
 * Note what is NOT required: condition MARKS, or a before-photo. A device can
 * genuinely arrive unmarked, and forcing a fake tick would corrupt the very
 * evidence this protects — `condition_captured_at` records that the agent
 * LOOKED, which is the checkable fact. A before-photo is still worth taking
 * (see the Intake tab) but is not on the counter's critical path: plenty of
 * real intakes happen without a camera to hand, and this guard should not be
 * the thing that stalls them.
 */
const intakeEvidenceComplete: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const missing: string[] = [];
  if (!job.conditionCapturedAt) missing.push('the visual condition check');
  if (!job.symptomNodeId) missing.push('a symptom-tree selection');
  if (!job.termsAcceptedAt) missing.push("the customer's acceptance of terms");

  const files = await prisma.attachment.findMany({
    where: { ownerType: 'JOB', ownerId: job.id, kind: 'SIGNATURE' },
    select: { kind: true },
  });
  if (files.length === 0) {
    missing.push("the customer's signature");
  }

  if (missing.length === 0) return ALLOW;
  return deny(`Intake is incomplete — still needed: ${missing.join(', ')}.`);
};

// ---------------------------------------------------------------------------
// Module 2 (§3) — bench discipline
// ---------------------------------------------------------------------------

/**
 * BOOKED → ASSIGNED: "Technician profile must match device skill matrix."
 *
 * Checked on the transition rather than only at assignment time because a job
 * can be assigned, reassigned, or have its device swapped between those
 * moments — the gate has to hold at the point the work actually starts.
 *
 * This is a MATCHING rule, not a mandatory-assignment rule. TriServe's counter
 * flow books a job in and moves it to DIAGNOSING before anyone picks it up, so
 * an unassigned job has no technician to check and passes; the rule bites the
 * moment somebody IS on the job. Requiring an assignee here instead would be a
 * separate policy the proposal doesn't ask for, and would stall every job at
 * the front desk.
 *
 * A company that has not populated the skill matrix at all is NOT blocked:
 * an empty matrix means "not configured", and refusing every job until
 * somebody fills in a table would take the shop offline. Once ANY skill row
 * exists for the device's category, the rule is live.
 */
const engineerSkillMatch: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');
  if (!job.assignedEngineerId) return ALLOW; // Nobody to match yet.

  const device = job.deviceId
    ? await prisma.device.findFirst({
        where: { id: job.deviceId },
        select: { category: true },
      })
    : null;
  if (!device) return ALLOW; // Nothing to match against.

  const [matrixSize, skill] = await Promise.all([
    prisma.userSkill.count({
      where: {
        companyId: job.companyId,
        category: device.category,
        active: true,
        deletedAt: null,
      },
    }),
    prisma.userSkill.findFirst({
      where: {
        companyId: job.companyId,
        userId: job.assignedEngineerId,
        category: device.category,
        active: true,
        deletedAt: null,
      },
      select: { id: true },
    }),
  ]);

  if (matrixSize === 0) return ALLOW; // Matrix not configured for this class.
  if (skill) return ALLOW;
  return deny(
    `The assigned technician is not certified for ${device.category} devices. ` +
      'Reassign the job, or add the skill on the technician’s profile.',
  );
};

/**
 * IN_REPAIR → QC: "Forces input of actual labor hours and technician repair
 * notes." Both, not either — hours without notes is an unauditable number,
 * notes without hours make technician productivity unmeasurable.
 */
const repairWorkDeclared: WorkflowGuard = (ctx) => {
  const { job } = ctx;
  if (!job) return deny('Job context unavailable');

  const missing: string[] = [];
  // `labourHours` arrives as a Prisma Decimal; Number() handles Decimal,
  // string and number alike, and NaN falls through to "missing".
  const hours = job.labourHours == null ? NaN : Number(job.labourHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    missing.push('actual labour hours');
  }
  if (!job.techReport?.trim()) missing.push('a technician repair note');

  if (missing.length === 0) return ALLOW;
  return deny(
    `Submit for verification needs ${missing.join(' and ')} recorded first.`,
  );
};

/**
 * QC → READY: "Senior Quality Assurer approves diagnostic checklist. Requires
 * entry of hardware calibration logs & software flash checks."
 *
 * Every BLOCKING checklist item configured for the device's class must have a
 * PASS for the CURRENT attempt (attempt number = qc_reject_count + 1, so a
 * bounced job cannot coast on the checks it passed before rework). Items
 * requiring a measured value must carry one; items requiring a raw log file
 * must have an attachment on the job.
 */
const qcChecklistPassed: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const device = job.deviceId
    ? await prisma.device.findFirst({
        where: { id: job.deviceId },
        select: { category: true },
      })
    : null;
  if (!device) return ALLOW;

  const items = await prisma.qcChecklistItem.findMany({
    where: {
      companyId: job.companyId,
      category: device.category,
      active: true,
      deletedAt: null,
    },
    select: {
      id: true,
      code: true,
      label: true,
      blocking: true,
      requiresValue: true,
      requiresAttachment: true,
    },
  });
  if (items.length === 0) return ALLOW; // No checklist configured for this class.

  const attemptNo = (job.qcRejectCount ?? 0) + 1;
  const checks = await prisma.jobQcCheck.findMany({
    where: { jobId: job.id, attemptNo },
    select: { itemId: true, result: true, value: true },
  });
  const byItem = new Map(checks.map((c) => [c.itemId, c]));

  const outstanding: string[] = [];
  let needsLogFile = false;
  for (const item of items) {
    const check = byItem.get(item.id);
    if (!check) {
      outstanding.push(item.label);
      continue;
    }
    if (item.blocking && check.result !== 'PASS') {
      outstanding.push(`${item.label} (${check.result})`);
      continue;
    }
    if (item.requiresValue && !check.value?.trim()) {
      outstanding.push(`${item.label} (reading not entered)`);
      continue;
    }
    if (item.requiresAttachment && check.result === 'PASS') needsLogFile = true;
  }

  if (needsLogFile) {
    const logs = await prisma.attachment.count({
      where: {
        ownerType: 'JOB',
        ownerId: job.id,
        kind: { in: ['DOC', 'PHOTO_AFTER'] },
      },
    });
    if (logs === 0) {
      outstanding.push('the raw calibration log file (upload it to the job)');
    }
  }

  if (outstanding.length === 0) return ALLOW;
  return deny(
    `QC checklist attempt ${attemptNo} is not complete — outstanding: ${outstanding.join(', ')}.`,
  );
};

/**
 * QC → IN_REPAIR (rework): "Requires mandatory failure reason log; routes back
 * to the same tech." The routing half is JobsService's (it preserves
 * `assigned_engineer_id`); the reason is enforced here.
 *
 * The reason must be NEW: it is cleared when the job re-enters QC, so a stale
 * reason from the previous bounce cannot satisfy this one.
 */
const qcFailureLogged: WorkflowGuard = (ctx) => {
  const { job } = ctx;
  if (!job) return deny('Job context unavailable');
  if (job.qcFailureReason?.trim()) return ALLOW;
  return deny(
    'Record the specific failure reason before rejecting the unit back to the bench.',
  );
};

// ---------------------------------------------------------------------------
// The bench parts request loop — the two ends of the AWAITING_PARTS hold
// ---------------------------------------------------------------------------

/**
 * → AWAITING_PARTS: don't park a job in a parts hold with no parts on order.
 *
 * AWAITING_PARTS pauses the SLA clock, so moving a job into it is a
 * commercially meaningful act, not a label. Requiring at least one live
 * request makes the hold mean what it says: somebody has actually asked for
 * something and the job is waiting on it. Without this a job could sit in a
 * paused state indefinitely with nothing on order and nobody accountable.
 *
 * A REJECTED or withdrawn request does not count — if the approver said no,
 * the job is not waiting for parts, it needs a new decision.
 */
const partsRequested: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const live = await prisma.jobPart.count({
    where: {
      jobId: job.id,
      status: {
        in: [
          'REQUESTED',
          'ISSUE_REQUESTED',
          'RESERVED',
          'ISSUED',
          'ACKNOWLEDGED',
        ],
      },
    },
  });
  if (live > 0) return ALLOW;

  return deny(
    'No parts have been requested for this job — raise the parts request first, then move it to Awaiting Parts.',
  );
};

/**
 * AWAITING_PARTS → IN_REPAIR: the bench must actually HAVE the parts.
 *
 * "Issued" is what stores asserts; ACKNOWLEDGED is the technician confirming
 * it arrived. Repair may not start while any requested line is still waiting
 * on a decision, on a picker, or on that confirmation — otherwise a job walks
 * into repair against parts nobody has handed over, and the shortfall surfaces
 * only when the technician reaches for a part that is not there.
 *
 * REJECTED lines are resolved, not outstanding: the approver said no and the
 * bench proceeded anyway, which is their call to make.
 */
const partsReceived: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const pending = await prisma.jobPart.findMany({
    where: {
      jobId: job.id,
      status: { in: ['REQUESTED', 'ISSUE_REQUESTED', 'RESERVED', 'ISSUED'] },
    },
    select: {
      status: true,
      part: { select: { partNumber: true, description: true } },
    },
    take: 10,
  });
  if (pending.length === 0) return ALLOW;

  const waiting: Record<string, string> = {
    REQUESTED: 'awaiting stores',
    ISSUE_REQUESTED: 'awaiting approval',
    RESERVED: 'approved, not yet picked',
    ISSUED: 'issued, not yet acknowledged',
  };
  const list = pending
    .map((l) => `${l.part.partNumber} (${waiting[l.status]})`)
    .join(', ');
  return deny(
    `Parts are still outstanding — the bench must have them in hand before repair starts: ${list}.`,
  );
};

// ---------------------------------------------------------------------------
// Module 3 (§4 step 4) — the defective-return interlock
// ---------------------------------------------------------------------------

/**
 * "CRITICAL STEP. For brand warranty compliance, the system marks the job as
 * 'Pending Defective Return'. The technician cannot route the device to
 * QC_TESTING until they physically place the old, damaged component into a
 * secure storage bin and scan its unique serial barcode into the system."
 *
 * Every job_part line flagged `core_required` and actually CONSUMED must carry
 * a scanned `core_serial_no`. Lines still merely RESERVED are not yet fitted,
 * so no core exists to return — blocking on those would stall jobs over parts
 * the technician decided not to use.
 */
const coreReturnsComplete: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const outstanding = await prisma.jobPart.findMany({
    where: {
      jobId: job.id,
      coreRequired: true,
      status: 'CONSUMED',
      coreReturnedAt: null,
    },
    select: { part: { select: { partNumber: true, description: true } } },
    take: 10,
  });
  if (outstanding.length === 0) return ALLOW;

  const list = outstanding
    .map((l) => `${l.part.partNumber} (${l.part.description})`)
    .join(', ');
  return deny(
    `Pending defective return — scan the old component into the secure return bin first: ${list}.`,
  );
};

// ---------------------------------------------------------------------------
// Module 5 (§6) — out-of-warranty financial authorization
// ---------------------------------------------------------------------------

/**
 * Has the customer been quoted AND agreed to the part of this repair THEY pay
 * for?
 *
 * Job-card T&C 5 and 9 and the proposal's §6 both land in the same place:
 * "The job cannot advance to the REPAIRING state until the customer clicks
 * 'Approve' and provides a verified digital signature or prepayment." The
 * gate keys off `coverage` (the billing consequence), never `warrantyStatus`:
 *
 *   FULL         → Samsung/the shop pays everything. Nothing to quote; pass.
 *                  (GOODWILL repairs resolve to FULL, so they pass too.)
 *   LABOUR_ONLY  → customer still pays parts   → quote + consent required.
 *   PARTS_ONLY   → customer still pays labour  → quote + consent required.
 *   NONE         → customer pays it all        → quote + consent required.
 *
 * There is no separate quote entity: a REPAIR_OW invoice on the job IS the
 * quote. Consent is any ONE of:
 *   - `customer_approved_at` set (portal click, counter signature, or a
 *     recorded verbal yes), or
 *   - money actually received against it (PARTIAL/PAID) — the proposal
 *     accepts prepayment in place of a signature.
 *
 * A VOID invoice is a withdrawn quote and does not count. Absent job context
 * the guard fails closed — an unknown job is not an approved one.
 */
const owQuoteApproved: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');
  if (job.coverage === 'FULL') return ALLOW;

  const quotes = await prisma.invoice.findMany({
    where: {
      jobId: job.id,
      type: 'REPAIR_OW',
      status: { not: 'VOID' },
      deletedAt: null,
    },
    select: {
      id: true,
      status: true,
      customerApprovedAt: true,
      customerDeclinedAt: true,
      quoteSentAt: true,
    },
  });

  if (quotes.length === 0) {
    return deny(
      'This repair is billable to the customer — raise the quote and get it approved before starting work.',
    );
  }

  const consented = quotes.some(
    (q) =>
      (q.customerApprovedAt !== null && q.customerDeclinedAt === null) ||
      q.status === 'PARTIAL' ||
      q.status === 'PAID',
  );
  if (consented) return ALLOW;

  const declined = quotes.every((q) => q.customerDeclinedAt !== null);
  if (declined) {
    return deny(
      'The customer declined this quote. Re-quote, or return the unit unrepaired.',
    );
  }
  const sent = quotes.some((q) => q.quoteSentAt !== null);
  return deny(
    sent
      ? 'Waiting on the customer to approve the quote (or pay a deposit).'
      : 'The quote has not been sent to the customer yet — send the approval link, or record their decision at the counter.',
  );
};

// ---------------------------------------------------------------------------
// Module 4 (§5) — BER lock-out
// ---------------------------------------------------------------------------

/**
 * A job with a live BER flag must not creep forward on the standard repair
 * track: "The system locks the technician out from making changes and
 * transfers ownership to the Workshop Supervisor."
 *
 * FLAGGED blocks (awaiting review). CERTIFIED blocks unless the supervisor
 * recorded REPAIR_ANYWAY as the outcome — the proposal allows a certified
 * unit to still be repaired when the customer insists. REJECTED and WITHDRAWN
 * never block: the supervisor has already put the job back on track.
 */
const berNotBlocking: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const ber = await prisma.berAssessment.findFirst({
    where: { jobId: job.id, status: { in: ['FLAGGED', 'CERTIFIED'] } },
    orderBy: { flaggedAt: 'desc' },
    select: {
      status: true,
      outcome: true,
      ratioPercent: true,
      thresholdPercent: true,
    },
  });
  if (!ber) return ALLOW;

  if (ber.status === 'FLAGGED') {
    return deny(
      `Beyond Economic Repair review pending — estimated cost is ${ber.ratioPercent}% ` +
        `of the device value (threshold ${ber.thresholdPercent}%). A supervisor must review before work continues.`,
    );
  }
  if (ber.outcome === 'REPAIR_ANYWAY') return ALLOW;
  return deny(
    'This device is certified Beyond Economic Repair — resolve it as a replacement, salvage or return rather than a repair.',
  );
};

// ---------------------------------------------------------------------------
// Module 6 (§7 step 4) — the OTP handshake
// ---------------------------------------------------------------------------

/**
 * READY → DISPATCHED: "The system blocks the agent from selecting 'Delivered'
 * until the entered PIN matches the generated OTP."
 *
 * The PIN is verified by LogisticsService, which stamps `verified_at` on the
 * OTP row; this guard checks that a verification actually happened and is
 * still current — i.e. it belongs to the LATEST issued PIN, so a stale
 * verification from a superseded code cannot be replayed.
 *
 * A job with no customer phone on file can never receive an SMS, and would be
 * permanently undeliverable. That is a real front-desk situation (walk-in,
 * dealer drop-off), so the counter records the handover against a verified
 * identity instead — which is what "override" exists for. This guard denies;
 * it does not pretend the case cannot happen.
 */
const collectionOtpVerified: WorkflowGuard = async (ctx) => {
  const { job, prisma } = ctx;
  if (!job) return deny('Job context unavailable');

  const latest = await prisma.jobCollectionOtp.findFirst({
    where: { jobId: job.id },
    orderBy: { createdAt: 'desc' },
    select: { verifiedAt: true, voidedAt: true, expiresAt: true },
  });

  if (!latest) {
    return deny(
      'No collection PIN has been issued for this job — issue one and verify it with the customer.',
    );
  }
  if (latest.verifiedAt) return ALLOW;
  if (latest.voidedAt) {
    return deny('The collection PIN was voided — issue a fresh one.');
  }
  if (latest.expiresAt.getTime() < Date.now()) {
    return deny('The collection PIN has expired — issue a fresh one.');
  }
  return deny(
    "Enter the customer's 6-digit collection PIN to confirm the handover.",
  );
};

/** guard_code → predicate. */
export const WORKFLOW_GUARDS: Readonly<Record<string, WorkflowGuard>> = {
  // Task 1.2 / proposal Module 5
  ow_quote_approved: owQuoteApproved,
  // Proposal Module 1
  intake_evidence_complete: intakeEvidenceComplete,
  // Proposal Module 2
  engineer_skill_match: engineerSkillMatch,
  repair_work_declared: repairWorkDeclared,
  qc_checklist_passed: qcChecklistPassed,
  qc_failure_logged: qcFailureLogged,
  // Proposal Module 3
  core_returns_complete: coreReturnsComplete,
  // The bench parts request loop — the two ends of the AWAITING_PARTS hold.
  parts_requested: partsRequested,
  parts_received: partsReceived,
  // Proposal Module 4
  ber_not_blocking: berNotBlocking,
  // Proposal Module 6
  collection_otp_verified: collectionOtpVerified,
};
