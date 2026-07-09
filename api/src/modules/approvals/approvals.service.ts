import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Prisma,
  type Approval,
  type ApprovalRule,
  type ApprovalStatus,
  type ApprovalType,
} from '@prisma/client';
import { roleHasPermission, type PaginatedResponse } from '@triserve/shared';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { getCurrentUser } from '../../common/context/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { ApprovalListQueryDto } from './dto/approvals.dto';

/** Wire shape of one approval (snake_case per API convention). */
export interface ApprovalEntry {
  id: string;
  company_id: string;
  branch_id: string;
  type: ApprovalType;
  ref_type: string | null;
  ref_id: string | null;
  payload_json: unknown;
  requested_by: string;
  approved_by: string | null;
  status: ApprovalStatus;
  reason: string;
  requested_at: string;
  decided_at: string | null;
}

/** Input to {@link ApprovalsService.request}. */
export interface ApprovalRequestInput {
  branchId: string;
  /** Entity awaiting approval — nullable: approval may PRECEDE the entity. */
  refType?: string | null;
  refId?: string | null;
  /** The proposed change (free-form JSON per type), stored as payload_json. */
  payload?: Record<string, unknown> | null;
  /** Requester's justification (required, §4.11). */
  reason: string;
}

/**
 * Context checked against approval_rules thresholds by
 * {@link ApprovalsService.isRequired}. `amount` is in BIGINT minor units of
 * the company base currency (money convention); `percent` is a plain
 * percentage (12 ⇒ 12%).
 */
export interface ApprovalContext {
  amount?: bigint | number;
  percent?: number | string;
}

export interface ApprovalRequirement {
  required: boolean;
  /** The enabled rule for (company, type), when one exists. */
  rule: ApprovalRule | null;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * PURE threshold check (unit-testable without a DB): does `rule` gate an
 * action with the given context? Thresholds are OR-ed and INCLUSIVE
 * (amount/percent >= threshold ⇒ approval required). No rule or a disabled
 * rule never gates.
 */
export function ruleRequiresApproval(
  rule: Pick<
    ApprovalRule,
    'enabled' | 'thresholdAmount' | 'thresholdPercent'
  > | null,
  context: ApprovalContext,
): boolean {
  if (!rule || !rule.enabled) return false;
  if (rule.thresholdAmount !== null && context.amount !== undefined) {
    if (BigInt(context.amount) >= rule.thresholdAmount) return true;
  }
  if (rule.thresholdPercent !== null && context.percent !== undefined) {
    if (new Prisma.Decimal(context.percent).gte(rule.thresholdPercent)) {
      return true;
    }
  }
  return false;
}

/**
 * Generic approvals framework (Task 0.5, DESIGN.md §4.11 / E8).
 *
 * ONE mechanism gates every sensitive action (refunds, voids, big
 * discounts, POs, adjustments, job reopens, manual journals, …).
 *
 * HOOK FOR LATER MODULES — the intended call pattern before any gated
 * action (no domain action is wired yet, by design):
 *
 *   const { required } = await approvals.isRequired('REFUND', { amount });
 *   if (required) {
 *     const approval = await approvals.request('REFUND', {
 *       branchId, refType: 'Invoice', refId, payload: { amount }, reason,
 *     });
 *     return { pending_approval: approval };   // stop; do NOT perform yet
 *   }
 *   // …perform the action; on later APPROVED, the caller re-checks the
 *   // approval row (status === 'APPROVED') and executes, backfilling
 *   // ref_id if the entity was created after the request.
 *
 * AUDIT: Approval is in AUDITED_MODELS, so request() logs CREATE and
 * decide()'s update logs a mechanical UPDATE automatically; decide()
 * ADDITIONALLY records the semantic APPROVE/REJECT row via
 * AuditService.record() with full before/after snapshots.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Create a PENDING approval. Actor = current user from the request
   * context (also enforced as requested_by). Company comes from the actor
   * (and is force-injected by the company-scope extension).
   */
  async request(
    type: ApprovalType,
    input: ApprovalRequestInput,
  ): Promise<ApprovalEntry> {
    const user = getCurrentUser();
    if (!user) {
      throw new UnauthorizedException(
        'ApprovalsService.request requires an authenticated request context',
      );
    }

    // Branch users may only raise approvals for their own branch.
    assertBranchAccess(user, input.branchId);

    // Fail with a clear 400 (not a raw FK error) on an unknown/foreign
    // branch — the company-scope extension already filters this lookup.
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId },
    });
    if (!branch) {
      throw new BadRequestException('Unknown branch for this company');
    }

    const approval = await this.prisma.approval.create({
      data: {
        // Explicit AND force-injected by the company-scope extension.
        companyId: user.companyId,
        branchId: input.branchId,
        type,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        // Wire/service input is a plain JSON object — safe as InputJsonValue.
        payloadJson: (input.payload ?? undefined) as
          Prisma.InputJsonObject | undefined,
        requestedById: user.userId,
        reason: input.reason,
        // status defaults to PENDING, requestedAt to now().
      },
    });

    return toEntry(approval);
  }

  /**
   * Decide a PENDING approval: APPROVED or REJECTED. Requires
   * 'approval.decide' (also guarded at the endpoint — this is defense in
   * depth for direct service calls from later modules). Rejections require
   * a reason. Double-decides are refused with 409 CONFLICT; the terminal
   * status is stamped with approved_by + decided_at. Emits the semantic
   * APPROVE/REJECT audit row.
   */
  async decide(
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    decider: AuthUser,
    reason?: string,
  ): Promise<ApprovalEntry> {
    if (!roleHasPermission(decider.role, 'approval.decide')) {
      throw new ForbiddenException('Missing permission(s): approval.decide');
    }
    if (decision === 'REJECTED' && !reason?.trim()) {
      throw new BadRequestException('A reason is required to reject');
    }

    // Company-scope extension pins this read to the decider's tenant, so a
    // foreign approval 404s rather than leaking.
    const before = await this.prisma.approval.findFirst({
      where: { id: approvalId },
    });
    if (!before) {
      throw new NotFoundException('Approval not found');
    }
    if (before.status !== 'PENDING') {
      throw new ConflictException(
        `Approval already decided (status=${before.status})`,
      );
    }
    // Branch-scoped deciders may only decide their own branch's approvals.
    assertBranchAccess(decider, before.branchId);

    let after: Approval;
    try {
      after = await this.prisma.approval.update({
        // status=PENDING in the WHERE closes the double-decide race: a
        // concurrent decision that landed first makes this throw P2025.
        where: { id: approvalId, status: 'PENDING' as const },
        data: {
          status: decision,
          approvedById: decider.userId,
          decidedAt: new Date(),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new ConflictException('Approval already decided');
      }
      throw e;
    }

    // Semantic audit row (the extension only sees a mechanical UPDATE).
    await this.audit.record({
      entityType: 'Approval',
      entityId: after.id,
      action: decision === 'APPROVED' ? 'APPROVE' : 'REJECT',
      before: before,
      after: after,
      companyId: after.companyId,
      branchId: after.branchId,
      actorUserId: decider.userId,
    });

    return toEntry(after);
  }

  /**
   * Does an action of `type` need approval for this company? Reads the
   * (company, type) approval_rules row — thresholds are compared by the
   * pure {@link ruleRequiresApproval}. No rule / disabled ⇒ not required.
   * Company defaults to the current request-context user's.
   */
  async isRequired(
    type: ApprovalType,
    context: ApprovalContext,
    companyId?: string,
  ): Promise<ApprovalRequirement> {
    const effectiveCompanyId = companyId ?? getCurrentUser()?.companyId;
    if (!effectiveCompanyId) {
      throw new UnauthorizedException(
        'ApprovalsService.isRequired requires a company (context or argument)',
      );
    }
    // Company-scope extension re-tightens this to the acting user's tenant.
    const rule = await this.prisma.approvalRule.findFirst({
      where: { companyId: effectiveCompanyId, type, enabled: true },
    });
    return { required: ruleRequiresApproval(rule, context), rule };
  }

  /** Company-scoped, filtered, paginated approvals (newest first). */
  async list(
    query: ApprovalListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<ApprovalEntry>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId is set explicitly AND re-tightened by the company-scope
    // extension (defense in depth); branch users are further pinned to
    // their home branch by BRANCH_SCOPED_MODELS.
    const where: Prisma.ApprovalWhereInput = {
      companyId: user.companyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.approval.count({ where }),
      this.prisma.approval.findMany({
        where,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toEntry), page, page_size: pageSize, total };
  }
}

function toEntry(a: Approval): ApprovalEntry {
  return {
    id: a.id,
    company_id: a.companyId,
    branch_id: a.branchId,
    type: a.type,
    ref_type: a.refType,
    ref_id: a.refId,
    payload_json: a.payloadJson ?? null,
    requested_by: a.requestedById,
    approved_by: a.approvedById,
    status: a.status,
    reason: a.reason,
    requested_at: a.requestedAt.toISOString(),
    decided_at: a.decidedAt?.toISOString() ?? null,
  };
}
