import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type DeviceCategory,
  type SwapUnitStatus,
} from '@prisma/client';
import { validateDeviceIdentifier, type PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { normalizeImeiSerial } from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { JobsService } from '../jobs/jobs.service';
import type {
  ExecuteSwapDto,
  SwapUnitListQueryDto,
  UpsertSwapUnitDto,
} from './dto/ber.dto';

/**
 * Swap Buffer Stock and device replacement (SCMS proposal Module 4, §5
 * steps 4–5).
 *
 * "The system issues a new unit from a strictly isolated inventory segment
 * known as the 'Swap Buffer Stock' (which contains unboxed, replacement-only
 * units). The system blocks standard commercial inventory access for this
 * step."
 *
 * The isolation is STRUCTURAL. Swap units live in their own table that the
 * POS, the parts ledger and the products catalogue do not join to — there is
 * no query anywhere in the system that could accidentally sell one over the
 * counter, because no selling code path can see them. A boolean flag on a
 * shared table would have relied on every future query remembering to check
 * it; this relies on nothing.
 *
 * Step 5, "Primary Identity Realignment", is the subtle half: the customer's
 * history must follow them to the new IMEI without pretending the old device
 * never existed. Both `devices` rows are kept and cross-linked, the original
 * is stamped `decommissioned_at`, and the device-history endpoint walks the
 * chain. Nothing is rewritten and nothing is lost.
 */

export interface SwapUnitWire {
  id: string;
  branch_id: string;
  model_id: string | null;
  model_label: string | null;
  category: DeviceCategory;
  imei_serial: string;
  color: string | null;
  cost: string | null;
  currency: string | null;
  status: SwapUnitStatus;
  allocated_job_id: string | null;
  issued_at: string | null;
  notes: string | null;
}

export interface DeviceSwapWire {
  id: string;
  job_id: string;
  branch_id: string;
  old_device_id: string;
  new_device_id: string;
  swap_unit_id: string;
  old_imei_serial: string | null;
  new_imei_serial: string | null;
  history_job_count: number;
  reason: string | null;
  authorized_by: string;
  authorized_at: string;
}

export interface ExecuteSwapResult {
  held: boolean;
  swap: DeviceSwapWire | null;
  pending_approval?: ApprovalEntry;
}

const DEFAULT_PAGE_SIZE = 25;

@Injectable()
export class SwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  // ------------------------------------------------------- buffer stock

  async listUnits(
    query: SwapUnitListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<SwapUnitWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.SwapUnitWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { imeiSerial: { contains: query.q } },
              { modelLabel: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.swapUnit.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.swapUnit.count({ where }),
    ]);

    return { data: rows.map(unitToWire), page, page_size: pageSize, total };
  }

  /** POST /swap-stock — book a replacement-only unit into the buffer. */
  async addUnit(
    dto: UpsertSwapUnitDto,
    user: AuthUser,
  ): Promise<SwapUnitWire> {
    assertBranchAccess(user, dto.branch_id);

    const category = dto.category ?? 'HHP';
    const imei = normalizeImeiSerial(dto.imei_serial);
    if (!imei) {
      throw new BadRequestException('imei_serial is required');
    }
    // A replacement unit is about to BECOME a customer's device identity, so
    // its identifier is held to exactly the same standard as one captured at
    // the counter — a mistyped IMEI here poisons every future warranty claim
    // on the replacement.
    const check = validateDeviceIdentifier(category, imei);
    if (!check.ok) {
      throw new UnprocessableEntityException(check.reason);
    }

    if (dto.model_id) {
      const model = await this.prisma.deviceModel.findFirst({
        where: { id: dto.model_id, deletedAt: null },
        select: { id: true },
      });
      if (!model) {
        throw new BadRequestException('model_id does not match a device model');
      }
    }

    try {
      const row = await this.prisma.swapUnit.create({
        data: {
          id: randomUUID(),
          companyId: user.companyId,
          branchId: dto.branch_id,
          modelId: dto.model_id ?? null,
          modelLabel: dto.model_label ?? null,
          category,
          imeiSerial: imei,
          color: dto.color ?? null,
          cost: dto.cost ? BigInt(dto.cost) : null,
          currency: dto.currency ?? null,
          status: 'IN_STOCK',
          notes: dto.notes ?? null,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return unitToWire(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          `A swap unit with serial ${imei} is already registered`,
        );
      }
      throw e;
    }
  }

  /**
   * DELETE /swap-stock/{id} — withdraw a unit from the buffer (damaged,
   * recalled, returned to the manufacturer). Refuses while it is committed to
   * a job: the customer has been promised that specific unit.
   */
  async retireUnit(id: string, user: AuthUser): Promise<SwapUnitWire> {
    const unit = await this.prisma.swapUnit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!unit) throw new NotFoundException('Swap unit not found');
    if (unit.status === 'ALLOCATED') {
      throw new ConflictException(
        'This unit is allocated to a job — resolve that job before withdrawing it',
      );
    }
    if (unit.status === 'ISSUED') {
      throw new ConflictException(
        'This unit has already been issued to a customer',
      );
    }

    const row = await this.prisma.swapUnit.update({
      where: { id },
      data: { status: 'RETIRED', updatedById: user.userId },
    });
    return unitToWire(row);
  }

  // ------------------------------------------------------- execute swap

  /**
   * POST /jobs/{id}/swap (§5 steps 4–5).
   *
   * Everything below happens in ONE transaction. A half-completed swap is the
   * worst possible outcome: a customer holding a device the system does not
   * know they own, or two live identities for one person's phone.
   */
  async execute(
    jobId: string,
    dto: ExecuteSwapDto,
    user: AuthUser,
  ): Promise<ExecuteSwapResult> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);

    const unit = await this.prisma.swapUnit.findFirst({
      where: { id: dto.swap_unit_id, deletedAt: null },
    });
    if (!unit) throw new NotFoundException('Swap unit not found');
    if (unit.status !== 'IN_STOCK' && unit.allocatedJobId !== jobId) {
      throw new ConflictException(
        `That swap unit is ${unit.status.toLowerCase()} and cannot be issued to this job`,
      );
    }
    // The buffer is held per branch; issuing another branch's unit would leave
    // their shelf short and this one's count wrong.
    if (unit.branchId !== job.branchId) {
      throw new UnprocessableEntityException(
        'That swap unit is held at another branch — transfer it first',
      );
    }

    // §6: "Center Manager … Can approve … commercial swaps."
    const { required } = await this.approvals.isRequired('DEVICE_SWAP', {
      amount: unit.cost ?? 0n,
    });
    if (required) {
      if (dto.override_approval_id) {
        await this.approvals.consumeOverride(
          'DEVICE_SWAP',
          dto.override_approval_id,
          user,
          { refType: 'Job', refId: jobId },
        );
      } else {
        const approval = await this.approvals.request('DEVICE_SWAP', {
          branchId: job.branchId,
          refType: 'Job',
          refId: jobId,
          payload: {
            swap_unit_id: unit.id,
            new_imei: unit.imeiSerial,
            cost: unit.cost?.toString() ?? null,
            currency: unit.currency,
          },
          reason: dto.override_reason?.trim() || dto.reason,
        });
        return { held: true, swap: null, pending_approval: approval };
      }
    }

    const oldDevice = await this.prisma.device.findFirstOrThrow({
      where: { id: job.deviceId },
    });
    if (oldDevice.decommissionedAt) {
      throw new ConflictException(
        'This device has already been swapped out — it cannot be replaced twice',
      );
    }

    // How much history is following the customer to the new identity. Counted
    // BEFORE the swap so the number on the record is what was actually
    // carried across, not a figure that drifts as new jobs are booked.
    const historyJobCount = await this.prisma.job.count({
      where: { deviceId: oldDevice.id, deletedAt: null },
    });

    const now = new Date();
    const swap = await this.prisma.$transaction(async (tx) => {
      // 1. Create the replacement device against the SAME customer. A new row
      //    rather than editing the old one's IMEI: the history of the retired
      //    unit has to stay attached to the unit it happened to.
      const newDevice = await tx.device.create({
        data: {
          id: randomUUID(),
          companyId: job.companyId,
          customerId: job.customerId,
          brand: oldDevice.brand,
          model: unit.modelLabel ?? oldDevice.model,
          modelId: unit.modelId ?? oldDevice.modelId,
          category: unit.category,
          deviceType: oldDevice.deviceType,
          imeiSerial: unit.imeiSerial,
          color: unit.color ?? oldDevice.color,
          // The replacement's warranty starts now, not when the original was
          // bought — it is a different physical unit.
          purchaseDate: now,
          marketValue: unit.cost,
          marketValueCurrency: unit.currency,
          replacedDeviceId: oldDevice.id,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });

      // 2. Decommission the original and point it at its replacement.
      await tx.device.update({
        where: { id: oldDevice.id },
        data: {
          decommissionedAt: now,
          replacedByDeviceId: newDevice.id,
          updatedById: user.userId,
        },
      });

      // 3. Consume the buffer unit.
      await tx.swapUnit.update({
        where: { id: unit.id },
        data: {
          status: 'ISSUED',
          allocatedJobId: jobId,
          allocatedAt: unit.allocatedAt ?? now,
          issuedAt: now,
          issuedById: user.userId,
          updatedById: user.userId,
        },
      });

      // 4. Point the JOB at the replacement. The job is what the customer
      //    collects, so it must describe what they are actually handed.
      await tx.job.update({
        where: { id: jobId },
        data: {
          deviceId: newDevice.id,
          techLocked: false,
          techLockReason: null,
          notes: [job.notes, `Device swapped: ${oldDevice.imeiSerial ?? '—'} → ${unit.imeiSerial}`]
            .filter(Boolean)
            .join('\n'),
          updatedById: user.userId,
        },
      });

      // 5. The swap record itself — the join device history walks.
      const latestBer = await tx.berAssessment.findFirst({
        where: { jobId, status: 'CERTIFIED' },
        orderBy: { flaggedAt: 'desc' },
        select: { id: true },
      });

      return tx.deviceSwap.create({
        data: {
          id: randomUUID(),
          companyId: job.companyId,
          branchId: job.branchId,
          jobId,
          oldDeviceId: oldDevice.id,
          newDeviceId: newDevice.id,
          swapUnitId: unit.id,
          berAssessmentId: latestBer?.id ?? null,
          oldImeiSerial: oldDevice.imeiSerial,
          newImeiSerial: unit.imeiSerial,
          historyJobCount,
          reason: dto.reason,
          authorizedById: user.userId,
          authorizedAt: now,
          createdById: user.userId,
        },
      });
    });

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: { device_id: oldDevice.id, imei: oldDevice.imeiSerial },
      after: {
        device_id: swap.newDeviceId,
        imei: unit.imeiSerial,
        swap_id: swap.id,
        history_jobs_carried: historyJobCount,
      },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    return { held: false, swap: swapToWire(swap) };
  }

  /** GET /jobs/{id}/swaps — the replacements performed on this job. */
  async listForJob(jobId: string, user: AuthUser): Promise<DeviceSwapWire[]> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const rows = await this.prisma.deviceSwap.findMany({
      where: { jobId },
      orderBy: { authorizedAt: 'desc' },
    });
    return rows.map(swapToWire);
  }

  /**
   * Walk a device's replacement chain, oldest identity first.
   *
   * This is what makes §5 step 5 real for the engineer at the bench: given ANY
   * device in the chain, they see every identity the customer has held for
   * this unit, so "the mainboard has already been replaced twice" survives a
   * swap instead of resetting to a blank history.
   */
  async identityChain(deviceId: string): Promise<string[]> {
    // Walk backwards to the original, then forwards to the live unit. Bounded
    // at 32 hops: a longer chain means a data problem, and an unbounded walk
    // over a cycle would hang the request.
    let root = deviceId;
    for (let i = 0; i < 32; i++) {
      const row: { replacedDeviceId: string | null } | null =
        await this.prisma.device.findFirst({
          where: { id: root },
          select: { replacedDeviceId: true },
        });
      if (!row?.replacedDeviceId) break;
      root = row.replacedDeviceId;
    }

    const chain = [root];
    let cursor = root;
    for (let i = 0; i < 32; i++) {
      const row: { replacedByDeviceId: string | null } | null =
        await this.prisma.device.findFirst({
          where: { id: cursor },
          select: { replacedByDeviceId: true },
        });
      if (!row?.replacedByDeviceId) break;
      cursor = row.replacedByDeviceId;
      chain.push(cursor);
    }
    return chain;
  }
}

function unitToWire(u: {
  id: string;
  branchId: string;
  modelId: string | null;
  modelLabel: string | null;
  category: DeviceCategory;
  imeiSerial: string;
  color: string | null;
  cost: bigint | null;
  currency: string | null;
  status: SwapUnitStatus;
  allocatedJobId: string | null;
  issuedAt: Date | null;
  notes: string | null;
}): SwapUnitWire {
  return {
    id: u.id,
    branch_id: u.branchId,
    model_id: u.modelId,
    model_label: u.modelLabel,
    category: u.category,
    imei_serial: u.imeiSerial,
    color: u.color,
    cost: u.cost?.toString() ?? null,
    currency: u.currency,
    status: u.status,
    allocated_job_id: u.allocatedJobId,
    issued_at: u.issuedAt?.toISOString() ?? null,
    notes: u.notes,
  };
}

function swapToWire(s: {
  id: string;
  jobId: string;
  branchId: string;
  oldDeviceId: string;
  newDeviceId: string;
  swapUnitId: string;
  oldImeiSerial: string | null;
  newImeiSerial: string | null;
  historyJobCount: number;
  reason: string | null;
  authorizedById: string;
  authorizedAt: Date;
}): DeviceSwapWire {
  return {
    id: s.id,
    job_id: s.jobId,
    branch_id: s.branchId,
    old_device_id: s.oldDeviceId,
    new_device_id: s.newDeviceId,
    swap_unit_id: s.swapUnitId,
    old_imei_serial: s.oldImeiSerial,
    new_imei_serial: s.newImeiSerial,
    history_job_count: s.historyJobCount,
    reason: s.reason,
    authorized_by: s.authorizedById,
    authorized_at: s.authorizedAt.toISOString(),
  };
}
