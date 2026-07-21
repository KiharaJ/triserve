import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type ApprovalType,
  type JobCoverage,
  type LabourCode,
  type WarrantyClaimStatus,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import {
  assertBranchAccess,
  canSeeBranch,
} from '../../common/authz/branch-access';
import { normalizeImeiSerial } from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateWarrantyClaimDto,
  WarrantyClaimLineInput,
  ReconcileWarrantyClaimDto,
  SubmitWarrantyClaimDto,
  UpdateWarrantyClaimDto,
  WarrantyClaimListQueryDto,
} from './dto/warranty-claim.dto';

const DEFAULT_PAGE_SIZE = 20;

/** Wire shape of a warranty claim (snake_case; USD money as cent strings). */
export interface WarrantyClaimWire {
  id: string;
  branch_id: string;
  branch_code: string;
  job_id: string;
  job_no: string;
  claim_no: string | null;
  samsung_ref_no: string | null;
  ticket_no: string | null;
  gspn_status: string | null;
  labour_code: LabourCode | null;
  currency: 'USD';
  claim_amount_usd: string;
  /** The split GSPN settles on; all zero on claims raised before it existed. */
  labour_amount_usd: string;
  parts_amount_usd: string;
  shipping_amount_usd: string;
  tax_amount_usd: string;
  reimbursed_amount_usd: string | null;
  status: WarrantyClaimStatus;
  submitted_at: string | null;
  paid_at: string | null;
  repair_received_at: string | null;
  completed_at: string | null;
  delivered_at: string | null;
  notes: string | null;
  lines: WarrantyClaimLineWire[];
  created_at: string;
  updated_at: string;
}

/** One part claimed against Samsung, at THEIR reimbursement price. */
export interface WarrantyClaimLineWire {
  id: string;
  line_no: number;
  part_id: string | null;
  part_no: string;
  description: string | null;
  location: string | null;
  qty: number;
  unit_price_usd: string;
  amount_usd: string;
  part_serial_no: string | null;
  invoice_no: string | null;
}

/**
 * A guard that blocked a create, and how to report it if no override is used.
 * `error` is a factory so each guard keeps its own natural status code.
 */
interface GuardBreach {
  type: ApprovalType;
  payload: Record<string, unknown>;
  error: () => Error;
}

/**
 * Returned INSTEAD of a claim when an override was requested: nothing was
 * created, and the caller must wait for the approval to be decided and then
 * retry with `override_approval_id`.
 */
export interface ClaimOverridePending {
  held: true;
  pending_approval: ApprovalEntry;
}

/** A created claim, or a held override request — discriminate on `held`. */
export type CreateClaimResult = WarrantyClaimWire | ClaimOverridePending;

/** A job a GSPN claim might belong to — see {@link matchJobsBySerial}. */
export interface ClaimJobMatch {
  job_id: string;
  job_no: string;
  branch_code: string;
  customer_name: string;
  model: string | null;
  imei_serial: string | null;
  state_code: string;
  state_label: string;
  received_at: string;
  coverage: JobCoverage;
  existing_claim_ids: string[];
}

type ClaimFull = Prisma.WarrantyClaimGetPayload<{
  include: { branch: true; job: true; lines: true };
}>;

const FULL_INCLUDE = {
  branch: true,
  job: true,
  lines: { orderBy: { lineNo: 'asc' } },
} as const satisfies Prisma.WarrantyClaimInclude;

/**
 * Warranty claims (Task 4.1, DESIGN.md §4.7 / E13) — the In-Warranty side.
 *
 * A DRAFT claim records the USD value Samsung owes for an IW repair, linked to
 * its job. Task 4.1 is the schema + core CRUD (create/list/get/update-draft);
 * the submit → approve/reject → reconcile lifecycle and the AR–Samsung ledger
 * postings (§4.9) switch on in Task 4.2. Company- AND branch-scoped. Not
 * extension-audited (Task 4.2's status moves touch it inside a posting
 * transaction) — the service emits semantic AuditService rows instead.
 */
@Injectable()
export class WarrantyClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly posting: PostingService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(
    query: WarrantyClaimListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<WarrantyClaimWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.WarrantyClaimWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status as WarrantyClaimStatus } : {}),
      ...(query.labour_code ? { labourCode: query.labour_code } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.job_id ? { jobId: query.job_id } : {}),
      ...(query.q ? { claimNo: { contains: query.q } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.warrantyClaim.count({ where }),
      this.prisma.warrantyClaim.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<WarrantyClaimWire> {
    void user;
    return toWire(await this.load(id));
  }

  // ---------------------------------------------------------------- mutations

  /** POST /warranty-claims — open a DRAFT claim against a job. */
  async create(
    dto: CreateWarrantyClaimDto,
    user: AuthUser,
  ): Promise<CreateClaimResult> {
    const job = await this.loadJob(dto.job_id);
    const branchId = dto.branch_id ?? job.branchId;
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);

    const amount = BigInt(dto.claim_amount_usd);
    if (amount <= 0n) {
      throw new BadRequestException(
        'claim_amount_usd must be greater than zero',
      );
    }
    if (dto.claim_no)
      await this.assertClaimNoFree(user.companyId, dto.claim_no);

    const lines = (dto.lines ?? []).map((l, i) => buildLine(l, i + 1));
    await this.assertPartsInCompany(lines);

    // ---- guards, each overridable by an approved override (§4.11) ----------
    //
    // Both are recoverable business rules rather than data errors, so the
    // shape is the same: describe the problem, let an operator ask for an
    // override, and let an APPROVED one through exactly once.
    const duplicate = await this.prisma.warrantyClaim.findFirst({
      where: {
        jobId: job.id,
        deletedAt: null,
        status: { notIn: ['CANCELLED', 'REJECTED'] },
      },
      select: { id: true, claimNo: true },
    });
    const split = computeSplit(dto);
    const splitMismatch =
      split !== null &&
      split.labour + split.parts + split.shipping + split.tax !== amount;

    let breach: GuardBreach | null = null;
    if (duplicate) {
      breach = {
        type: 'DUPLICATE_WARRANTY_CLAIM',
        payload: { job_id: job.id, existing_claim_id: duplicate.id },
        error: () =>
          new ConflictException(
            `This job already has a claim (${duplicate.claimNo ?? 'a draft'}). Filing a second one is usually a mistake — request an override if it is deliberate.`,
          ),
      };
    } else if (splitMismatch && split) {
      const sum = split.labour + split.parts + split.shipping + split.tax;
      breach = {
        type: 'CLAIM_SPLIT_MISMATCH',
        payload: {
          job_id: job.id,
          claim_amount_usd: amount.toString(),
          component_sum: sum.toString(),
          labour_amount_usd: split.labour.toString(),
          parts_amount_usd: split.parts.toString(),
          shipping_amount_usd: split.shipping.toString(),
          tax_amount_usd: split.tax.toString(),
        },
        error: () =>
          new BadRequestException(
            `labour + parts + shipping + tax (${sum}) must equal claim_amount_usd (${amount})`,
          ),
      };
    }

    const held = await this.resolveOverride(
      breach,
      dto,
      branchId,
      job.id,
      user,
    );
    if (held) return held;

    const components = {
      labourAmountUsd: split?.labour ?? 0n,
      partsAmountUsd: split?.parts ?? 0n,
      shippingAmountUsd: split?.shipping ?? 0n,
      taxAmountUsd: split?.tax ?? 0n,
    };

    const claim = await this.prisma.warrantyClaim.create({
      data: {
        companyId: user.companyId,
        branchId,
        jobId: job.id,
        claimNo: dto.claim_no ?? null,
        samsungRefNo: dto.samsung_ref_no ?? null,
        ticketNo: dto.ticket_no ?? null,
        gspnStatus: dto.gspn_status ?? null,
        labourCode: dto.labour_code ?? null,
        claimAmountUsd: amount,
        ...components,
        repairReceivedAt: toDate(dto.repair_received_at),
        completedAt: toDate(dto.completed_at),
        deliveredAt: toDate(dto.delivered_at),
        status: 'DRAFT',
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
        lines: lines.length
          ? {
              create: lines.map((l) => ({
                companyId: user.companyId,
                ...l,
                createdById: user.userId,
                updatedById: user.userId,
              })),
            }
          : undefined,
      },
      include: FULL_INCLUDE,
    });

    await this.recordAudit(claim, 'CREATE', user, {
      job_no: claim.job.jobNo,
      claim_amount_usd: amount.toString(),
      lines: lines.length,
    });
    return toWire(claim);
  }

  /**
   * Suggest the job a GSPN claim belongs to, from the handset it names.
   *
   * A Warranty Claim Detail identifies the DEVICE (serial, masked IMEI), never
   * the job, so this is a lookup — not an assertion. It returns candidates for
   * a human to choose between: several jobs can share a serial (a repeat
   * repair, or a rework), and silently binding a payout to the wrong one would
   * be very hard to notice afterwards.
   *
   * Matched on serial, NOT IMEI: GSPN masks the IMEI on both documents
   * (`********1778019`), so it cannot identify anything.
   */
  async matchJobsBySerial(
    serial: string,
    user: AuthUser,
  ): Promise<ClaimJobMatch[]> {
    const normalized = normalizeImeiSerial(serial);
    if (!normalized) return [];

    const jobs = await this.prisma.job.findMany({
      where: {
        deletedAt: null,
        device: { imeiSerial: normalized, deletedAt: null },
      },
      include: {
        branch: { select: { code: true } },
        customer: { select: { name: true } },
        device: { select: { imeiSerial: true, model: true } },
        state: { select: { code: true, label: true } },
        warrantyClaims: {
          where: { deletedAt: null },
          select: { id: true, claimNo: true },
        },
      },
      orderBy: [{ receivedAt: 'desc' }],
      take: 10,
    });

    return jobs
      .filter((j) => canSeeBranch(user, j.branchId))
      .map((j) => ({
        job_id: j.id,
        job_no: j.jobNo,
        branch_code: j.branch.code,
        customer_name: j.customer.name,
        model: j.device.model,
        imei_serial: j.device.imeiSerial,
        state_code: j.state.code,
        state_label: j.state.label,
        received_at: j.receivedAt.toISOString(),
        coverage: j.coverage,
        // Surfaced so the operator can see a job that is ALREADY claimed —
        // filing a second claim against it is almost always a mistake.
        existing_claim_ids: j.warrantyClaims.map((c) => c.id),
      }));
  }

  /** PATCH /warranty-claims/{id} — DRAFT only. */
  async update(
    id: string,
    dto: UpdateWarrantyClaimDto,
    user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    const claim = await this.load(id);
    if (claim.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT claim can be edited');
    }
    if (dto.claim_amount_usd !== undefined) {
      const amount = BigInt(dto.claim_amount_usd);
      if (amount <= 0n) {
        throw new BadRequestException(
          'claim_amount_usd must be greater than zero',
        );
      }
    }
    if (dto.claim_no) {
      await this.assertClaimNoFree(claim.companyId, dto.claim_no, claim.id);
    }

    const updated = await this.prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: {
        ...(dto.claim_amount_usd !== undefined
          ? { claimAmountUsd: BigInt(dto.claim_amount_usd) }
          : {}),
        ...(dto.labour_code !== undefined
          ? { labourCode: dto.labour_code }
          : {}),
        ...(dto.claim_no !== undefined ? { claimNo: dto.claim_no } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        updatedById: user.userId,
      },
      include: FULL_INCLUDE,
    });

    await this.recordAudit(updated, 'UPDATE', user, {
      claim_amount_usd: updated.claimAmountUsd.toString(),
    });
    return toWire(updated);
  }

  /** POST /warranty-claims/{id}/submit — DRAFT → SUBMITTED (needs claim_no). */
  async submit(
    id: string,
    dto: SubmitWarrantyClaimDto,
    user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    const claim = await this.load(id);
    if (claim.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT claim can be submitted');
    }
    const claimNo = dto.claim_no ?? claim.claimNo;
    if (!claimNo) {
      throw new BadRequestException(
        'A Samsung claim number is required to submit',
      );
    }
    if (dto.claim_no && dto.claim_no !== claim.claimNo) {
      await this.assertClaimNoFree(claim.companyId, dto.claim_no, claim.id);
    }

    const updated = await this.prisma.warrantyClaim.update({
      where: { id: claim.id },
      data: {
        status: 'SUBMITTED',
        claimNo,
        ...(dto.labour_code !== undefined
          ? { labourCode: dto.labour_code }
          : {}),
        submittedAt: new Date(),
        updatedById: user.userId,
      },
      include: FULL_INCLUDE,
    });

    await this.recordAudit(updated, 'UPDATE', user, {
      status: 'SUBMITTED',
      claim_no: claimNo,
    });
    return toWire(updated);
  }

  /**
   * POST /warranty-claims/{id}/reconcile — record Samsung's decision and post
   * the ledger side-effect in the SAME transaction:
   *   - APPROVED (from SUBMITTED): Dr AR–Samsung / Cr Warranty Revenue;
   *   - REJECTED (from SUBMITTED): no posting;
   *   - PAID (from APPROVED): Dr Bank / Cr AR–Samsung for the reimbursed amount.
   */
  async reconcile(
    id: string,
    dto: ReconcileWarrantyClaimDto,
    user: AuthUser,
  ): Promise<WarrantyClaimWire> {
    const claim = await this.load(id);
    const { outcome } = dto;

    const legal =
      ((outcome === 'APPROVED' || outcome === 'REJECTED') &&
        claim.status === 'SUBMITTED') ||
      (outcome === 'PAID' && claim.status === 'APPROVED');
    if (!legal) {
      throw new ConflictException(
        `Cannot reconcile a ${claim.status} claim to ${outcome}`,
      );
    }

    const reimbursed =
      outcome === 'PAID'
        ? dto.reimbursed_amount_usd
          ? BigInt(dto.reimbursed_amount_usd)
          : claim.claimAmountUsd
        : null;
    if (reimbursed !== null && reimbursed <= 0n) {
      throw new BadRequestException(
        'reimbursed_amount_usd must be greater than zero',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.warrantyClaim.update({
        where: { id: claim.id },
        data: {
          status: outcome,
          ...(outcome === 'PAID'
            ? { reimbursedAmountUsd: reimbursed, paidAt: new Date() }
            : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          updatedById: user.userId,
        },
      });

      const base = {
        companyId: claim.companyId,
        branchId: claim.branchId,
        postedById: user.userId,
        claimNo: claim.claimNo ?? claim.id,
        claimId: claim.id,
      };
      if (outcome === 'APPROVED') {
        await this.posting.postWarrantyApproval(
          { ...base, amountUsd: claim.claimAmountUsd },
          tx,
        );
      } else if (outcome === 'PAID' && reimbursed !== null) {
        await this.posting.postWarrantyReimbursement(
          { ...base, amountUsd: reimbursed },
          tx,
        );
      }
    });

    await this.recordAudit(claim, 'UPDATE', user, {
      status: outcome,
      ...(reimbursed !== null
        ? { reimbursed_amount_usd: reimbursed.toString() }
        : {}),
    });
    return this.get(id, user);
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<ClaimFull> {
    const claim = await this.prisma.warrantyClaim.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!claim) throw new NotFoundException('Warranty claim not found');
    return claim;
  }

  private async loadJob(
    jobId: string,
  ): Promise<{ id: string; branchId: string }> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!job) {
      throw new BadRequestException(
        'job_id does not match a job of your company',
      );
    }
    return job;
  }

  private async assertBranchInCompany(branchId: string): Promise<void> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) {
      throw new BadRequestException(
        'branch_id does not match a branch of your company',
      );
    }
  }

  /**
   * The one place a guard breach turns into "blocked", "held" or "allowed".
   *
   * Three outcomes, and the order matters:
   *   - an APPROVED override supplied → spend it (single use) and proceed;
   *   - an override REQUESTED → raise a PENDING approval and do NOTHING;
   *   - neither → the guard's own error, unchanged from before overrides.
   *
   * Returning `null` means "carry on"; a held result means the caller must
   * stop and hand the pending approval back.
   */
  private async resolveOverride(
    breach: GuardBreach | null,
    dto: Pick<
      CreateWarrantyClaimDto,
      'request_override' | 'override_reason' | 'override_approval_id'
    >,
    branchId: string,
    jobId: string,
    user: AuthUser,
  ): Promise<ClaimOverridePending | null> {
    if (!breach) {
      // Nothing was blocking. Spending an override here would burn it for
      // nothing, so refuse rather than silently consume it.
      if (dto.override_approval_id) {
        throw new BadRequestException(
          'No override is needed for this claim — remove override_approval_id',
        );
      }
      return null;
    }

    if (dto.override_approval_id) {
      await this.approvals.consumeOverride(
        breach.type,
        dto.override_approval_id,
        user,
        { refType: 'Job', refId: jobId },
      );
      return null;
    }

    if (dto.request_override) {
      if (!dto.override_reason?.trim()) {
        throw new BadRequestException(
          'override_reason is required when requesting an override',
        );
      }
      const approval = await this.approvals.request(breach.type, {
        branchId,
        refType: 'Job',
        refId: jobId,
        payload: { ...breach.payload, blocked_by: breach.type },
        reason: dto.override_reason.trim(),
      });
      return { held: true, pending_approval: approval };
    }

    throw breach.error();
  }

  /**
   * Any `part_id` on a line must be one of OUR parts. The id is a bare UUID,
   * so nothing structural stops a claim line pointing at another tenant's
   * catalogue row; the company-scope extension filters the lookup.
   */
  private async assertPartsInCompany(
    lines: Array<{ partId: string | null }>,
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.partId).filter(Boolean))];
    if (ids.length === 0) return;
    const found = await this.prisma.part.findMany({
      where: { id: { in: ids as string[] }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException(
        'A claim line references a part that is not in your catalogue',
      );
    }
  }

  /** A Samsung claim number is unique per company (once assigned). */
  private async assertClaimNoFree(
    companyId: string,
    claimNo: string,
    exceptId?: string,
  ): Promise<void> {
    const existing = await this.prisma.warrantyClaim.findFirst({
      where: {
        companyId,
        claimNo,
        deletedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(`Claim number ${claimNo} is already in use`);
    }
  }

  private async recordAudit(
    claim: { id: string; companyId: string; branchId: string },
    action: 'CREATE' | 'UPDATE',
    user: AuthUser,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      entityType: 'WarrantyClaim',
      entityId: claim.id,
      action,
      after,
      companyId: claim.companyId,
      branchId: claim.branchId,
      actorUserId: user.userId,
    });
  }
}

function toWire(c: ClaimFull): WarrantyClaimWire {
  return {
    id: c.id,
    branch_id: c.branchId,
    branch_code: c.branch.code,
    job_id: c.jobId,
    job_no: c.job.jobNo,
    claim_no: c.claimNo,
    samsung_ref_no: c.samsungRefNo,
    ticket_no: c.ticketNo,
    gspn_status: c.gspnStatus,
    labour_code: c.labourCode,
    currency: 'USD',
    claim_amount_usd: c.claimAmountUsd.toString(),
    labour_amount_usd: c.labourAmountUsd.toString(),
    parts_amount_usd: c.partsAmountUsd.toString(),
    shipping_amount_usd: c.shippingAmountUsd.toString(),
    tax_amount_usd: c.taxAmountUsd.toString(),
    reimbursed_amount_usd: c.reimbursedAmountUsd?.toString() ?? null,
    status: c.status,
    submitted_at: c.submittedAt?.toISOString() ?? null,
    paid_at: c.paidAt?.toISOString() ?? null,
    repair_received_at: c.repairReceivedAt?.toISOString() ?? null,
    completed_at: c.completedAt?.toISOString() ?? null,
    delivered_at: c.deliveredAt?.toISOString() ?? null,
    notes: c.notes,
    lines: c.lines.map((l) => ({
      id: l.id,
      line_no: l.lineNo,
      part_id: l.partId,
      part_no: l.partNo,
      description: l.description,
      location: l.location,
      qty: l.qty,
      unit_price_usd: l.unitPriceUsd.toString(),
      amount_usd: l.amountUsd.toString(),
      part_serial_no: l.partSerialNo,
      invoice_no: l.invoiceNo,
    })),
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

/** ISO string → Date, tolerating the absent case. */
function toDate(s: string | undefined): Date | null {
  return s ? new Date(s) : null;
}

/**
 * The cost split, or null when the caller stated only a total.
 *
 * A hand-raised claim gives no components at all, which is legal — the
 * components then read as zero. Supplying SOME of them means the claim is
 * describing its own breakdown, and the caller (or an approver) has to stand
 * behind it summing to the total.
 */
function computeSplit(dto: CreateWarrantyClaimDto): {
  labour: bigint;
  parts: bigint;
  shipping: bigint;
  tax: bigint;
} | null {
  const given = [
    dto.labour_amount_usd,
    dto.parts_amount_usd,
    dto.shipping_amount_usd,
    dto.tax_amount_usd,
  ];
  if (given.every((v) => v === undefined)) return null;
  return {
    labour: BigInt(dto.labour_amount_usd ?? '0'),
    parts: BigInt(dto.parts_amount_usd ?? '0'),
    shipping: BigInt(dto.shipping_amount_usd ?? '0'),
    tax: BigInt(dto.tax_amount_usd ?? '0'),
  };
}

/** Normalise one line input; amount defaults to qty × unit price. */
function buildLine(l: WarrantyClaimLineInput, lineNo: number) {
  const qty = l.qty ?? 1;
  const unit = BigInt(l.unit_price_usd);
  return {
    lineNo,
    partId: l.part_id ?? null,
    partNo: l.part_no,
    description: l.description ?? null,
    location: l.location ?? null,
    qty,
    unitPriceUsd: unit,
    amountUsd:
      l.amount_usd !== undefined ? BigInt(l.amount_usd) : unit * BigInt(qty),
    partSerialNo: l.part_serial_no ?? null,
    invoiceNo: l.invoice_no ?? null,
  };
}
