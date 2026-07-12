import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type LabourCode,
  type WarrantyClaimStatus,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import { PostingService } from '../accounting/posting.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateWarrantyClaimDto,
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
  labour_code: LabourCode | null;
  currency: 'USD';
  claim_amount_usd: string;
  reimbursed_amount_usd: string | null;
  status: WarrantyClaimStatus;
  submitted_at: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

type ClaimFull = Prisma.WarrantyClaimGetPayload<{
  include: { branch: true; job: true };
}>;

const FULL_INCLUDE = { branch: true, job: true } as const;

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
  ): Promise<WarrantyClaimWire> {
    const job = await this.loadJob(dto.job_id);
    const branchId = dto.branch_id ?? job.branchId;
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);

    const amount = BigInt(dto.claim_amount_usd);
    if (amount <= 0n) {
      throw new BadRequestException('claim_amount_usd must be greater than zero');
    }
    if (dto.claim_no) await this.assertClaimNoFree(user.companyId, dto.claim_no);

    const claim = await this.prisma.warrantyClaim.create({
      data: {
        companyId: user.companyId,
        branchId,
        jobId: job.id,
        claimNo: dto.claim_no ?? null,
        labourCode: dto.labour_code ?? null,
        claimAmountUsd: amount,
        status: 'DRAFT',
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
      include: FULL_INCLUDE,
    });

    await this.recordAudit(claim, 'CREATE', user, {
      job_no: claim.job.jobNo,
      claim_amount_usd: amount.toString(),
    });
    return toWire(claim);
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
        ...(dto.labour_code !== undefined ? { labourCode: dto.labour_code } : {}),
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

  private async loadJob(jobId: string): Promise<{ id: string; branchId: string }> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
      select: { id: true, branchId: true },
    });
    if (!job) {
      throw new BadRequestException('job_id does not match a job of your company');
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
    labour_code: c.labourCode,
    currency: 'USD',
    claim_amount_usd: c.claimAmountUsd.toString(),
    reimbursed_amount_usd: c.reimbursedAmountUsd?.toString() ?? null,
    status: c.status,
    submitted_at: c.submittedAt?.toISOString() ?? null,
    paid_at: c.paidAt?.toISOString() ?? null,
    notes: c.notes,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}
