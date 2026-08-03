import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type DeviceCategory,
  type QcCheckResult,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { JobsService, type TransitionResult } from '../jobs/jobs.service';
import type {
  DeclareWorkDto,
  QcItemListQueryDto,
  QcRejectDto,
  SaveQcChecksDto,
  UpsertQcItemDto,
} from './dto/bench.dto';
import { SkillsService } from './skills.service';

/**
 * Quality control (SCMS proposal Module 2, §3).
 *
 * Two gates, both mandatory:
 *
 *   IN_REPAIR → QC   "Forces input of actual labor hours and technician
 *                     repair notes."  → {@link declareWork}
 *   QC → READY       "Senior Quality Assurer approves diagnostic checklist.
 *                     Requires entry of hardware calibration logs & software
 *                     flash checks."  → {@link saveChecks} + the
 *                     `qc_checklist_passed` guard
 *   QC → DIAGNOSIS   "Requires mandatory failure reason log; routes back to
 *                     the same tech."  → {@link reject}
 *
 * The checklist ITSELF is per-device-class config so a fridge is not asked to
 * pass a handset's water-resistance test; results are recorded per ATTEMPT so
 * a unit that failed twice never looks like one that passed first time.
 */

export interface QcItemWire {
  id: string;
  category: DeviceCategory;
  code: string;
  label: string;
  help: string | null;
  requires_value: boolean;
  requires_attachment: boolean;
  blocking: boolean;
  sort_order: number;
  active: boolean;
}

/** One checklist line for a job, with any result already recorded. */
export interface JobQcLineWire {
  item_id: string;
  code: string;
  label: string;
  help: string | null;
  requires_value: boolean;
  requires_attachment: boolean;
  blocking: boolean;
  result: QcCheckResult | null;
  value: string | null;
  note: string | null;
  recorded_at: string | null;
}

/** The whole QC panel for a job. */
export interface JobQcWire {
  job_id: string;
  category: DeviceCategory;
  /** 1 for the first pass; increments with every rejection. */
  attempt_no: number;
  qc_reject_count: number;
  qc_submitted_at: string | null;
  qc_failure_reason: string | null;
  qc_approved_by: string | null;
  qc_approved_at: string | null;
  labour_hours: string | null;
  tech_report: string | null;
  /** Whether the CALLER may sign this gate off (permission + skill + not own work). */
  can_approve: boolean;
  /** Why not, when `can_approve` is false. */
  approve_blocked_reason: string | null;
  lines: JobQcLineWire[];
}

const DEFAULT_PAGE_SIZE = 100;

@Injectable()
export class QcService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly skills: SkillsService,
  ) {}

  // -------------------------------------------------------- template config

  async listItems(
    query: QcItemListQueryDto,
  ): Promise<PaginatedResponse<QcItemWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.QcChecklistItemWhereInput = {
      deletedAt: null,
      ...(query.category ? { category: query.category } : {}),
      ...(query.q ? { label: { contains: query.q } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.qcChecklistItem.findMany({
        where,
        orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.qcChecklistItem.count({ where }),
    ]);

    return { data: rows.map(itemToWire), page, page_size: pageSize, total };
  }

  async upsertItem(
    dto: UpsertQcItemDto,
    user: AuthUser,
    id?: string,
  ): Promise<QcItemWire> {
    const data = {
      category: dto.category,
      code: dto.code,
      label: dto.label,
      help: dto.help ?? null,
      requiresValue: dto.requires_value ?? false,
      requiresAttachment: dto.requires_attachment ?? false,
      blocking: dto.blocking ?? true,
      sortOrder: dto.sort_order ?? 0,
      active: dto.active ?? true,
      deletedAt: null,
      updatedById: user.userId,
    };
    try {
      const row = id
        ? await this.prisma.qcChecklistItem.update({ where: { id }, data })
        : await this.prisma.qcChecklistItem.create({
            data: {
              ...data,
              id: randomUUID(),
              companyId: user.companyId,
              createdById: user.userId,
            },
          });
      return itemToWire(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A ${dto.category} check with code '${dto.code}' already exists`,
        );
      }
      throw e;
    }
  }

  /**
   * Retire a check. SOFT, so past results still resolve their item and a
   * historical QC record stays readable. Live jobs currently sitting in QC
   * simply stop being asked for it.
   */
  async removeItem(id: string, user: AuthUser): Promise<{ id: string }> {
    const row = await this.prisma.qcChecklistItem.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('QC checklist item not found');
    await this.prisma.qcChecklistItem.update({
      where: { id },
      data: { active: false, deletedAt: new Date(), updatedById: user.userId },
    });
    return { id };
  }

  // ------------------------------------------------------------- per job

  /** GET /jobs/{id}/qc — the checklist for the CURRENT attempt. */
  async panel(jobId: string, user: AuthUser): Promise<JobQcWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });
    const attemptNo = job.qcRejectCount + 1;

    const [items, checks] = await Promise.all([
      this.prisma.qcChecklistItem.findMany({
        where: { category: device.category, active: true, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.jobQcCheck.findMany({ where: { jobId, attemptNo } }),
    ]);
    const byItem = new Map(checks.map((c) => [c.itemId, c]));

    const blocked = await this.approveBlockedReason(
      job.assignedEngineerId,
      device.category,
      user,
    );

    return {
      job_id: jobId,
      category: device.category,
      attempt_no: attemptNo,
      qc_reject_count: job.qcRejectCount,
      qc_submitted_at: job.qcSubmittedAt?.toISOString() ?? null,
      qc_failure_reason: job.qcFailureReason,
      qc_approved_by: job.qcApprovedById,
      qc_approved_at: job.qcApprovedAt?.toISOString() ?? null,
      labour_hours: job.labourHours?.toString() ?? null,
      tech_report: job.techReport,
      can_approve: blocked === null,
      approve_blocked_reason: blocked,
      lines: items.map((i) => {
        const c = byItem.get(i.id);
        return {
          item_id: i.id,
          code: i.code,
          label: i.label,
          help: i.help,
          requires_value: i.requiresValue,
          requires_attachment: i.requiresAttachment,
          blocking: i.blocking,
          result: c?.result ?? null,
          value: c?.value ?? null,
          note: c?.note ?? null,
          recorded_at: c?.recordedAt.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * PATCH /jobs/{id}/work — the technician declares hours + notes.
   *
   * Restricted to the ASSIGNED engineer (or a manager): the number is a
   * productivity measure attributed to a named person, and letting a colleague
   * fill it in would quietly corrupt every technician-performance report built
   * on it.
   */
  async declareWork(
    jobId: string,
    dto: DeclareWorkDto,
    user: AuthUser,
  ): Promise<{ labour_hours: string; tech_report: string }> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertBenchUnlocked(job, user);

    const isOwner = job.assignedEngineerId === user.userId;
    const isSupervisor = user.role !== 'TECHNICIAN';
    if (!isOwner && !isSupervisor) {
      throw new ForbiddenException(
        'Only the assigned technician can declare the work on this job',
      );
    }

    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        labourHours: new Prisma.Decimal(dto.labour_hours),
        techReport: dto.tech_report,
        updatedById: user.userId,
      },
    });

    return {
      labour_hours: dto.labour_hours.toFixed(2),
      tech_report: dto.tech_report,
    };
  }

  /**
   * PUT /jobs/{id}/qc-checks — record the calibration/flash results for the
   * current attempt.
   *
   * Replace semantics within the attempt (the assurer works one form), but
   * results from PREVIOUS attempts are never touched: a rework history is
   * exactly what the first-time-fix metric is computed from.
   */
  async saveChecks(
    jobId: string,
    dto: SaveQcChecksDto,
    user: AuthUser,
  ): Promise<JobQcWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });
    const attemptNo = job.qcRejectCount + 1;

    const itemIds = [...new Set(dto.checks.map((c) => c.item_id))];
    const items = await this.prisma.qcChecklistItem.findMany({
      where: { id: { in: itemIds }, deletedAt: null },
      select: {
        id: true,
        category: true,
        label: true,
        requiresValue: true,
      },
    });
    const byId = new Map(items.map((i) => [i.id, i]));

    for (const c of dto.checks) {
      const item = byId.get(c.item_id);
      if (!item) {
        throw new BadRequestException(
          `item_id ${c.item_id} does not match a QC checklist item`,
        );
      }
      if (item.category !== device.category) {
        throw new UnprocessableEntityException(
          `"${item.label}" is a ${item.category} check, but this device is ${device.category}`,
        );
      }
      // Reject a PASS with no reading here rather than letting the transition
      // guard refuse later — the assurer is looking at the form right now.
      if (item.requiresValue && c.result === 'PASS' && !c.value?.trim()) {
        throw new UnprocessableEntityException(
          `"${item.label}" needs the measured reading entered before it can pass`,
        );
      }
    }

    const now = new Date();
    for (const c of dto.checks) {
      await this.prisma.jobQcCheck.upsert({
        where: {
          jobId_itemId_attemptNo: { jobId, itemId: c.item_id, attemptNo },
        },
        update: {
          result: c.result,
          value: c.value ?? null,
          note: c.note ?? null,
          recordedById: user.userId,
          recordedAt: now,
        },
        create: {
          id: randomUUID(),
          companyId: job.companyId,
          jobId,
          itemId: c.item_id,
          attemptNo,
          result: c.result,
          value: c.value ?? null,
          note: c.note ?? null,
          recordedById: user.userId,
          recordedAt: now,
        },
      });
    }

    return this.panel(jobId, user);
  }

  /**
   * POST /jobs/{id}/qc-approve — sign the gate off and move the job to READY.
   *
   * The extra check beyond the permission is the proposal's "SENIOR Quality
   * Assurer": the approver must be certified on this device class AND must not
   * be the technician who did the work. Self-approval would make the gate
   * ceremonial.
   */
  async approve(
    jobId: string,
    user: AuthUser,
    toStateCode = 'READY',
  ): Promise<TransitionResult> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });

    const blocked = await this.approveBlockedReason(
      job.assignedEngineerId,
      device.category,
      user,
    );
    if (blocked) throw new ForbiddenException(blocked);

    // The `qc_checklist_passed` guard on the edge does the completeness check;
    // this call just performs the move through the one legal path.
    return this.jobs.transition(
      jobId,
      { to_state_code: toStateCode, note: 'QC approved' },
      user,
    );
  }

  /**
   * POST /jobs/{id}/qc-reject — bounce the unit back with a mandatory reason.
   *
   * Reason and move are ONE action so neither can happen without the other,
   * and both land in the same transaction as the state change via the normal
   * transition path (the `qc_failure_logged` guard then finds the reason
   * already written).
   */
  async reject(
    jobId: string,
    dto: QcRejectDto,
    user: AuthUser,
  ): Promise<TransitionResult> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const device = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
      select: { category: true },
    });

    const blocked = await this.approveBlockedReason(
      job.assignedEngineerId,
      device.category,
      user,
      // Rejecting your OWN work is fine — a technician spotting their own
      // mistake and pulling the job back is good practice, not a control
      // failure. Only APPROVING is self-dealing.
      { allowOwnWork: true },
    );
    if (blocked) throw new ForbiddenException(blocked);

    await this.prisma.job.update({
      where: { id: jobId },
      data: { qcFailureReason: dto.reason, updatedById: user.userId },
    });

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: { qc_reject_count: job.qcRejectCount },
      after: { qc_failure_reason: dto.reason },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return this.jobs.transition(
      jobId,
      {
        to_state_code: dto.to_state_code ?? 'IN_REPAIR',
        note: `QC rejected: ${dto.reason}`,
      },
      user,
    );
  }

  // ------------------------------------------------------------- helpers

  /**
   * Why this user may NOT sign off the QC gate, or null when they may.
   * Returned as a REASON rather than a boolean so the UI can disable the
   * button and say why, instead of the assurer discovering it on submit.
   */
  private async approveBlockedReason(
    assignedEngineerId: string | null,
    category: DeviceCategory,
    user: AuthUser,
    opts: { allowOwnWork?: boolean } = {},
  ): Promise<string | null> {
    if (!opts.allowOwnWork && assignedEngineerId === user.userId) {
      return 'You worked on this job — quality sign-off has to come from someone else.';
    }
    if (!(await this.skills.canApproveQc(user.userId, category))) {
      return `You are not certified as a Quality Assurer for ${category} devices.`;
    }
    return null;
  }

  /**
   * SCMS proposal Modules 4/5: while the bench is locked (a BER review is
   * open, or an OW quote is with the customer) the technician may READ the job
   * but not change it. Managers are not locked out — somebody has to be able
   * to resolve the situation.
   */
  private assertBenchUnlocked(
    job: { techLocked: boolean; techLockReason: string | null },
    user: AuthUser,
  ): void {
    if (!job.techLocked) return;
    // The lock transfers OWNERSHIP to the supervisor; it does not freeze the
    // job for everyone. A manager must still be able to act — otherwise the
    // lock has no way out.
    if (user.role !== 'TECHNICIAN') return;
    throw new ConflictException(
      job.techLockReason ??
        'This job is locked pending a supervisor decision — it is not on your bench right now.',
    );
  }
}

function itemToWire(i: {
  id: string;
  category: DeviceCategory;
  code: string;
  label: string;
  help: string | null;
  requiresValue: boolean;
  requiresAttachment: boolean;
  blocking: boolean;
  sortOrder: number;
  active: boolean;
}): QcItemWire {
  return {
    id: i.id,
    category: i.category,
    code: i.code,
    label: i.label,
    help: i.help,
    requires_value: i.requiresValue,
    requires_attachment: i.requiresAttachment,
    blocking: i.blocking,
    sort_order: i.sortOrder,
    active: i.active,
  };
}
