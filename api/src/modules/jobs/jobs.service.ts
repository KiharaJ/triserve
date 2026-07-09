import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type WarrantyStatus } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import {
  normalizeImeiSerial,
  normalizePhone,
  normalizeSoNumber,
} from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { WorkflowService } from '../workflow/workflow.service';
import type {
  CreateJobDto,
  DispatchJobDto,
  JobListQueryDto,
  TransitionJobDto,
  UpdateJobDto,
} from './dto/job.dto';

/** One legal + authorized next move for the current user (GET /jobs/{id}). */
export interface AllowedTransition {
  to_state_code: string;
  to_label: string;
  requires_approval: boolean;
}

/** Wire shape of one job (snake_case per API convention). */
export interface JobWire {
  id: string;
  job_no: string;
  so_number: string | null;
  branch_id: string;
  customer_id: string;
  device_id: string;
  booked_by: string;
  assigned_engineer_id: string | null;
  warranty_status: WarrantyStatus;
  fault_reported: string | null;
  fault_code_id: string | null;
  tech_report: string | null;
  state_id: string;
  state_code: string;
  state_label: string;
  received_at: string;
  ready_at: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  received_by_customer: string | null;
  waybill_no: string | null;
  claim_id: string | null;
  invoice_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Nested customer summary for the job detail view. */
export interface JobCustomerSummary {
  id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  location: string | null;
}

/** Nested device summary (+ resolved model code) for the job detail view. */
export interface JobDeviceSummary {
  id: string;
  brand: string;
  model: string | null;
  model_id: string | null;
  model_code: string | null;
  category: string;
  imei_serial: string | null;
  color: string | null;
}

/** GET /jobs/{id} — full detail incl. relations + legal next moves. */
export interface JobDetailWire extends JobWire {
  customer: JobCustomerSummary;
  device: JobDeviceSummary;
  allowed_next_transitions: AllowedTransition[];
}

/** Result of a transition/dispatch — either applied, or HELD for approval. */
export interface TransitionResult {
  /** true when the move requires_approval: state is unchanged, approval PENDING. */
  held: boolean;
  job: JobDetailWire;
  /** Present only when held — the PENDING approval to be decided later. */
  pending_approval?: ApprovalEntry;
}

const DEFAULT_PAGE_SIZE = 20;

type JobWithState = Prisma.JobGetPayload<{ include: { state: true } }>;
type JobDetail = Prisma.JobGetPayload<{
  include: {
    state: true;
    customer: true;
    device: { include: { deviceModel: true } };
  };
}>;

/**
 * Jobs — the service-centre lifecycle (Task 1.3, DESIGN.md §4.3 / §5).
 *
 * Jobs are COMPANY- AND BRANCH-scoped by the Prisma extension; TECHNICIANs
 * are restricted FURTHER here to jobs assigned to them (a per-user filter, not
 * a tenancy boundary). State changes flow EXCLUSIVELY through transition() /
 * dispatch(), which validate every move via WorkflowService and route
 * requires_approval edges through ApprovalsService (holding the move until
 * approved). Every applied move emits a semantic TRANSITION audit row.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- queries

  /** GET /jobs — company/branch scoped, filtered, paginated (newest first). */
  async list(
    query: JobListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<JobWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const receivedAt =
      query.from || query.to
        ? {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {}),
          }
        : undefined;

    // companyId set explicitly AND re-tightened by the scope extension;
    // branch users are further pinned to their home branch (Job is
    // branch-scoped).
    const where: Prisma.JobWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.state ? { state: { code: query.state } } : {}),
      ...(query.warranty_status
        ? { warrantyStatus: query.warranty_status }
        : {}),
      ...(receivedAt ? { receivedAt } : {}),
      ...(query.q ? { OR: searchClauses(query.q) } : {}),
    };

    // TECHNICIANs only ever see their own jobs — override any filter.
    if (user.role === 'TECHNICIAN') {
      where.assignedEngineerId = user.userId;
    } else if (query.assigned_engineer_id) {
      where.assignedEngineerId = query.assigned_engineer_id;
    }

    const [total, rows] = await Promise.all([
      this.prisma.job.count({ where }),
      this.prisma.job.findMany({
        where,
        include: { state: true },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /jobs/{id} — full detail incl. customer, device, legal next moves. */
  async get(id: string, user: AuthUser): Promise<JobDetailWire> {
    const job = await this.prisma.job.findFirst({
      where: this.scopedIdWhere(id, user),
      include: {
        state: true,
        customer: true,
        device: { include: { deviceModel: true } },
      },
    });
    if (!job) throw new NotFoundException('Job not found');

    const allowed = await this.allowedNextTransitions(job, user);
    return toDetailWire(job, allowed);
  }

  // -------------------------------------------------------------- mutations

  /** POST /jobs — opens a job card at the workflow INITIAL state. */
  async create(dto: CreateJobDto, user: AuthUser): Promise<JobDetailWire> {
    const branch = await this.resolveBranch(dto, user);
    const customerId = await this.resolveCustomer(dto, user);
    const deviceId = await this.resolveDevice(dto, user, customerId);

    if (dto.fault_code_id)
      await this.assertFaultCodeInCompany(dto.fault_code_id);
    if (dto.assigned_engineer_id) {
      await this.assertUserInCompany(dto.assigned_engineer_id);
    }

    const initial = await this.prisma.workflowState.findFirst({
      where: { isInitial: true, active: true, deletedAt: null },
    });
    if (!initial) {
      throw new UnprocessableEntityException(
        'No initial workflow state is configured for this company',
      );
    }

    const now = new Date();
    const jobNo = await this.generateJobNo(
      user.companyId,
      branch.id,
      branch.code,
      now.getFullYear(),
    );

    const job = await this.prisma.job.create({
      data: {
        companyId: user.companyId, // also force-injected by the extension
        jobNo,
        soNumber: normalizeSoNumber(dto.so_number),
        branchId: branch.id,
        customerId,
        deviceId,
        bookedById: user.userId,
        assignedEngineerId: dto.assigned_engineer_id ?? null,
        warrantyStatus: dto.warranty_status ?? 'UNKNOWN',
        faultReported: dto.fault_reported ?? null,
        faultCodeId: dto.fault_code_id ?? null,
        stateId: initial.id,
        receivedAt: now,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });

    return this.get(job.id, user);
  }

  /** PATCH /jobs/{id} — mutable fields only (never status). */
  async update(
    id: string,
    dto: UpdateJobDto,
    user: AuthUser,
  ): Promise<JobDetailWire> {
    await this.getRow(id, user); // clean 404 + technician restriction

    if (dto.assigned_engineer_id) {
      await this.assertUserInCompany(dto.assigned_engineer_id);
    }
    if (dto.fault_code_id)
      await this.assertFaultCodeInCompany(dto.fault_code_id);

    await this.prisma.job.update({
      where: { id },
      data: {
        ...(dto.fault_reported !== undefined
          ? { faultReported: dto.fault_reported }
          : {}),
        ...(dto.tech_report !== undefined
          ? { techReport: dto.tech_report }
          : {}),
        ...(dto.assigned_engineer_id !== undefined
          ? { assignedEngineerId: dto.assigned_engineer_id }
          : {}),
        ...(dto.warranty_status !== undefined
          ? { warrantyStatus: dto.warranty_status }
          : {}),
        ...(dto.fault_code_id !== undefined
          ? { faultCodeId: dto.fault_code_id }
          : {}),
        ...(dto.so_number !== undefined
          ? { soNumber: normalizeSoNumber(dto.so_number) }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        updatedById: user.userId,
      },
    });

    return this.get(id, user);
  }

  /** POST /jobs/{id}/transition — the ONLY way a job's status changes. */
  async transition(
    id: string,
    dto: TransitionJobDto,
    user: AuthUser,
  ): Promise<TransitionResult> {
    const job = await this.getRow(id, user);
    return this.applyTransition(
      job,
      dto.to_state_code,
      user,
      dto.note ?? null,
      {},
    );
  }

  /** POST /jobs/{id}/dispatch — convenience wrapper for READY → DISPATCHED. */
  async dispatch(
    id: string,
    dto: DispatchJobDto,
    user: AuthUser,
  ): Promise<TransitionResult> {
    const job = await this.getRow(id, user);
    return this.applyTransition(
      job,
      'DISPATCHED',
      user,
      `Dispatched to ${dto.received_by}`,
      {
        receivedByCustomer: dto.received_by,
        waybillNo: dto.waybill_no ?? null,
      },
    );
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Apply (or HOLD) a state move. Validates via WorkflowService.assertTransition
   * (throws 422 on illegal/unauthorized/guard-blocked). When the matched edge
   * requires_approval, creates a PENDING approval and leaves the job UNCHANGED
   * (a later phase wires approval → apply). Otherwise updates the state,
   * stamps ready_at / dispatched_at (+ dispatched_by) on the relevant states,
   * merges any `extra` fields (dispatch details), and emits a semantic
   * TRANSITION audit row (the extension separately logs the mechanical UPDATE).
   */
  private async applyTransition(
    job: JobWithState,
    toStateCode: string,
    user: AuthUser,
    note: string | null,
    extra: Prisma.JobUncheckedUpdateInput,
  ): Promise<TransitionResult> {
    const fromCode = job.state.code;
    const check = await this.workflow.assertTransition(
      user.companyId,
      fromCode,
      toStateCode,
      user,
      { job },
    );

    const to = await this.prisma.workflowState.findFirst({
      where: { code: toStateCode, deletedAt: null },
    });
    if (!to) {
      // assertTransition already validated the target exists; defensive.
      throw new UnprocessableEntityException(
        `Unknown workflow state '${toStateCode}'`,
      );
    }

    // requires_approval → hold the move; return the PENDING approval.
    if (check.transition?.requires_approval) {
      const approval = await this.approvals.request('REOPEN_JOB', {
        branchId: job.branchId,
        refType: 'Job',
        refId: job.id,
        payload: {
          from_state_code: fromCode,
          to_state_code: toStateCode,
          note,
        },
        reason:
          note ?? `Transition ${fromCode} → ${toStateCode} requires approval`,
      });
      return {
        held: true,
        job: await this.get(job.id, user),
        pending_approval: approval,
      };
    }

    const now = new Date();
    const data: Prisma.JobUncheckedUpdateInput = {
      ...extra,
      stateId: to.id,
      updatedById: user.userId,
    };
    if (to.code === 'READY' && !job.readyAt) {
      data.readyAt = now;
    }
    if (to.code === 'DISPATCHED') {
      if (!job.dispatchedAt) data.dispatchedAt = now;
      data.dispatchedById = user.userId;
    }

    await this.prisma.job.update({ where: { id: job.id }, data });

    // Semantic TRANSITION row (the extension only sees a mechanical UPDATE).
    await this.audit.record({
      entityType: 'Job',
      entityId: job.id,
      action: 'TRANSITION',
      before: { state_code: fromCode },
      after: { state_code: toStateCode, note },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return { held: false, job: await this.get(job.id, user) };
  }

  /**
   * Scoped job lookup (with current state) used by the mutation paths.
   * TECHNICIANs can only load jobs assigned to them → clean 404 otherwise.
   */
  private async getRow(id: string, user: AuthUser): Promise<JobWithState> {
    const job = await this.prisma.job.findFirst({
      where: this.scopedIdWhere(id, user),
      include: { state: true },
    });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  /** Common id + soft-delete + technician-visibility where clause. */
  private scopedIdWhere(id: string, user: AuthUser): Prisma.JobWhereInput {
    return {
      id,
      deletedAt: null,
      ...(user.role === 'TECHNICIAN'
        ? { assignedEngineerId: user.userId }
        : {}),
    };
  }

  /** Every legal AND authorized next move for this user (job detail view). */
  private async allowedNextTransitions(
    job: JobWithState,
    user: AuthUser,
  ): Promise<AllowedTransition[]> {
    const edges = await this.prisma.workflowTransition.findMany({
      where: { fromStateId: job.stateId, deletedAt: null },
      include: { toState: true },
    });

    const out: AllowedTransition[] = [];
    for (const edge of edges) {
      const check = await this.workflow.canTransition(
        user.companyId,
        job.state.code,
        edge.toState.code,
        user,
        { job },
      );
      if (check.allowed) {
        out.push({
          to_state_code: edge.toState.code,
          to_label: edge.toState.label,
          requires_approval: edge.requiresApproval,
        });
      }
    }
    return out;
  }

  /**
   * Concurrency-safe job_no: `{BRANCH_CODE}-{YYYY}-{seq padded to 6}`.
   * The per-(company,branch,year) counter is bumped atomically with the
   * canonical MySQL sequence idiom — one `INSERT … ON DUPLICATE KEY UPDATE`
   * using LAST_INSERT_ID as a session-scoped return channel, inside an
   * interactive transaction so the follow-up SELECT reads the SAME
   * connection's value. The @@unique(company,branch,year) row lock serializes
   * concurrent bumps: N parallel creates get N distinct sequential numbers.
   */
  private async generateJobNo(
    companyId: string,
    branchId: string,
    branchCode: string,
    year: number,
  ): Promise<string> {
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO job_counters (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1), NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1), updated_at = NOW(3)`;
      const rows = await tx.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });

    return `${branchCode}-${year}-${String(seq).padStart(6, '0')}`;
  }

  // ---- intake resolution --------------------------------------------------

  /** Resolve + authorize the job's branch (payload or the user's home). */
  private async resolveBranch(
    dto: CreateJobDto,
    user: AuthUser,
  ): Promise<{ id: string; code: string }> {
    const branchId = dto.branch_id ?? user.homeBranchId;
    if (!branchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, branchId);

    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) {
      throw new BadRequestException(
        'branch_id does not match a branch of your company',
      );
    }
    return { id: branch.id, code: branch.code };
  }

  /**
   * Resolve the customer: an existing (scoped) customer_id, OR find-or-create
   * by normalized phone from the nested payload (§6.1 "find/create by phone").
   */
  private async resolveCustomer(
    dto: CreateJobDto,
    user: AuthUser,
  ): Promise<string> {
    if (dto.customer_id && dto.customer) {
      throw new BadRequestException(
        'Provide either customer_id or a nested customer, not both',
      );
    }
    if (dto.customer_id) {
      const existing = await this.prisma.customer.findFirst({
        where: { id: dto.customer_id, deletedAt: null },
      });
      if (!existing) {
        throw new BadRequestException(
          'customer_id does not match a customer of your company',
        );
      }
      return existing.id;
    }
    if (!dto.customer) {
      throw new BadRequestException(
        'A customer_id or a nested customer is required',
      );
    }

    const phoneNormalized = normalizePhone(dto.customer.phone);
    if (phoneNormalized) {
      const match = await this.prisma.customer.findFirst({
        where: { phoneNormalized, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (match) return match.id;
    }

    const created = await this.prisma.customer.create({
      data: {
        companyId: user.companyId,
        name: dto.customer.name,
        phone: dto.customer.phone ?? null,
        phoneNormalized,
        altPhone: dto.customer.alt_phone ?? null,
        altPhoneNormalized: normalizePhone(dto.customer.alt_phone),
        email: dto.customer.email ?? null,
        location: dto.customer.location ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });
    return created.id;
  }

  /**
   * Resolve the device: an existing (scoped) device_id, OR find-or-create by
   * normalized imei_serial within the company; a new device is linked to the
   * resolved customer (E3 keys the timeline on IMEI/serial).
   */
  private async resolveDevice(
    dto: CreateJobDto,
    user: AuthUser,
    customerId: string,
  ): Promise<string> {
    if (dto.device_id && dto.device) {
      throw new BadRequestException(
        'Provide either device_id or a nested device, not both',
      );
    }
    if (dto.device_id) {
      const existing = await this.prisma.device.findFirst({
        where: { id: dto.device_id, deletedAt: null },
      });
      if (!existing) {
        throw new BadRequestException(
          'device_id does not match a device of your company',
        );
      }
      return existing.id;
    }
    if (!dto.device) {
      throw new BadRequestException(
        'A device_id or a nested device is required',
      );
    }

    const imei = normalizeImeiSerial(dto.device.imei_serial);
    if (imei) {
      const match = await this.prisma.device.findFirst({
        where: { imeiSerial: imei, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (match) return match.id;
    }

    if (dto.device.model_id) {
      const model = await this.prisma.deviceModel.findFirst({
        where: { id: dto.device.model_id, deletedAt: null },
      });
      if (!model) {
        throw new BadRequestException(
          'device.model_id does not match a model of your company',
        );
      }
    }

    const created = await this.prisma.device.create({
      data: {
        companyId: user.companyId,
        customerId,
        brand: dto.device.brand ?? 'Samsung',
        model: dto.device.model ?? null,
        modelId: dto.device.model_id ?? null,
        category: dto.device.category,
        imeiSerial: imei,
        color: dto.device.color ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });
    return created.id;
  }

  private async assertFaultCodeInCompany(faultCodeId: string): Promise<void> {
    const fc = await this.prisma.faultCode.findFirst({
      where: { id: faultCodeId, deletedAt: null },
    });
    if (!fc) {
      throw new BadRequestException(
        'fault_code_id does not match a fault code of your company',
      );
    }
  }

  private async assertUserInCompany(userId: string): Promise<void> {
    const u = await this.prisma.user.findFirst({ where: { id: userId } });
    if (!u) {
      throw new BadRequestException(
        'assigned_engineer_id does not match a user of your company',
      );
    }
  }
}

/**
 * `q` search across job_no, so_number, customer name/phone and device IMEI.
 * Phone/IMEI are normalized with the SAME functions used on save so any messy
 * input format hits the stored canonical form.
 */
function searchClauses(q: string): Prisma.JobWhereInput[] {
  const clauses: Prisma.JobWhereInput[] = [
    { jobNo: { contains: q } },
    { soNumber: { contains: q } },
    { customer: { name: { contains: q } } },
    { customer: { phone: { contains: q } } },
  ];
  const phone = normalizePhone(q);
  if (phone) {
    clauses.push(
      { customer: { phoneNormalized: { contains: phone } } },
      { customer: { altPhoneNormalized: { contains: phone } } },
    );
  }
  const imei = normalizeImeiSerial(q);
  if (imei) {
    clauses.push({ device: { imeiSerial: { contains: imei } } });
  }
  return clauses;
}

function toWire(j: JobWithState): JobWire {
  return {
    id: j.id,
    job_no: j.jobNo,
    so_number: j.soNumber,
    branch_id: j.branchId,
    customer_id: j.customerId,
    device_id: j.deviceId,
    booked_by: j.bookedById,
    assigned_engineer_id: j.assignedEngineerId,
    warranty_status: j.warrantyStatus,
    fault_reported: j.faultReported,
    fault_code_id: j.faultCodeId,
    tech_report: j.techReport,
    state_id: j.stateId,
    state_code: j.state.code,
    state_label: j.state.label,
    received_at: j.receivedAt.toISOString(),
    ready_at: j.readyAt?.toISOString() ?? null,
    dispatched_at: j.dispatchedAt?.toISOString() ?? null,
    dispatched_by: j.dispatchedById,
    received_by_customer: j.receivedByCustomer,
    waybill_no: j.waybillNo,
    claim_id: j.claimId,
    invoice_id: j.invoiceId,
    notes: j.notes,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
  };
}

function toDetailWire(
  j: JobDetail,
  allowed: AllowedTransition[],
): JobDetailWire {
  return {
    ...toWire(j),
    customer: {
      id: j.customer.id,
      name: j.customer.name,
      phone: j.customer.phone,
      phone_normalized: j.customer.phoneNormalized,
      email: j.customer.email,
      location: j.customer.location,
    },
    device: {
      id: j.device.id,
      brand: j.device.brand,
      model: j.device.model,
      model_id: j.device.modelId,
      model_code: j.device.deviceModel?.modelCode ?? null,
      category: j.device.category,
      imei_serial: j.device.imeiSerial,
      color: j.device.color,
    },
    allowed_next_transitions: allowed,
  };
}
