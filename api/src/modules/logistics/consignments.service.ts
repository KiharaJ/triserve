import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type ConsignmentDirection,
  type ConsignmentStatus,
  type ScanPoint,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  AddConsignmentJobsDto,
  ArriveConsignmentDto,
  ConsignmentListQueryDto,
  CreateConsignmentDto,
  DispatchConsignmentDto,
  ScanConsignmentDto,
} from './dto/logistics.dto';

/**
 * Hub-and-spoke logistics (SCMS proposal Module 6, §7 steps 2–3).
 *
 * "If the device was dropped off at a satellite collection point rather than
 * the main repair hub, the system prompts the operator to initiate a transit
 * action. The system assigns a distinct tracking label to a secure 'Logistics
 * Tote' and bundles all outbound devices into a unified digital consignment
 * manifest… At each point along the chain, handlers must scan the barcode on
 * the tote."
 *
 * A consignment IS the tote: one physical container, one manifest, many jobs.
 *
 * TWO deliberate design points:
 *
 *  - The tote LABEL and the consignment NUMBER are separate. Totes are reused;
 *    the same label carries a different manifest next week, so scanning a
 *    label resolves to whichever manifest is currently in flight on it.
 *  - Scans are append-only. A chain of custody you can edit afterwards is not
 *    a chain of custody, so `consignment_scans` is never updated or deleted
 *    (and is deliberately excluded from the audit extension for exactly that
 *    reason — it is already its own trail).
 */

export interface ConsignmentJobWire {
  job_id: string;
  job_no: string;
  customer_name: string;
  device: string;
  imei_serial: string | null;
  added_at: string;
  checked_in_at: string | null;
  /** True when the manifest lists it but it was NOT checked in on arrival. */
  missing: boolean;
}

export interface ConsignmentScanWire {
  id: string;
  scan_point: ScanPoint;
  location: string | null;
  handler_name: string | null;
  scanned_at: string;
  scanned_by: string | null;
  note: string | null;
}

export interface ConsignmentWire {
  id: string;
  consignment_no: string;
  tote_label: string;
  from_branch_id: string;
  from_branch: string;
  to_branch_id: string;
  to_branch: string;
  direction: ConsignmentDirection;
  status: ConsignmentStatus;
  courier_name: string | null;
  courier_ref: string | null;
  waybill_no: string | null;
  sealed_at: string | null;
  dispatched_at: string | null;
  arrived_at: string | null;
  job_count: number;
  /** Manifest lines not checked in at arrival — the reason the manifest exists. */
  missing_count: number;
  notes: string | null;
  jobs: ConsignmentJobWire[];
  scans: ConsignmentScanWire[];
}

const DEFAULT_PAGE_SIZE = 25;

type ConsignmentRow = Prisma.ConsignmentGetPayload<{
  include: {
    fromBranch: { select: { name: true } };
    toBranch: { select: { name: true } };
    jobs: {
      include: {
        job: {
          select: {
            jobNo: true;
            customer: { select: { name: true } };
            device: { select: { brand: true; model: true; imeiSerial: true } };
          };
        };
      };
    };
    scans: true;
  };
}>;

const FULL_INCLUDE = {
  fromBranch: { select: { name: true } },
  toBranch: { select: { name: true } },
  jobs: {
    include: {
      job: {
        select: {
          jobNo: true,
          customer: { select: { name: true } },
          device: { select: { brand: true, model: true, imeiSerial: true } },
        },
      },
    },
  },
  scans: true,
} as const;

@Injectable()
export class ConsignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ConsignmentListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<ConsignmentWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.ConsignmentWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.from_branch_id ? { fromBranchId: query.from_branch_id } : {}),
      ...(query.to_branch_id ? { toBranchId: query.to_branch_id } : {}),
      AND: [
        ...(query.q
          ? [
              {
                OR: [
                  { consignmentNo: { contains: query.q } },
                  { toteLabel: { contains: query.q } },
                  { waybillNo: { contains: query.q } },
                ],
              },
            ]
          : []),
        // A consignment has TWO branch columns, so the blunt branch-scope
        // extension cannot filter it (same situation as StockTransfer). A
        // branch user sees totes they are sending OR receiving — both legs
        // concern them.
        ...(user.scope === 'branch' && user.homeBranchId
          ? [
              {
                OR: [
                  { fromBranchId: user.homeBranchId },
                  { toBranchId: user.homeBranchId },
                ],
              },
            ]
          : []),
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.consignment.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.consignment.count({ where }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string): Promise<ConsignmentWire> {
    const row = await this.prisma.consignment.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!row) throw new NotFoundException('Consignment not found');
    return toWire(row);
  }

  /** Resolve a scanned TOTE label to the manifest currently riding on it. */
  async findByTote(label: string): Promise<ConsignmentWire> {
    const row = await this.prisma.consignment.findFirst({
      where: {
        toteLabel: label,
        deletedAt: null,
        // Totes are reused, so a label alone is ambiguous across history. The
        // one that matters to a handler is the one in flight.
        status: { in: ['OPEN', 'IN_TRANSIT'] },
      },
      include: FULL_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      throw new NotFoundException(
        `No open consignment is currently on tote ${label}`,
      );
    }
    return toWire(row);
  }

  /** POST /consignments — open a tote and (optionally) pack it. */
  async create(
    dto: CreateConsignmentDto,
    user: AuthUser,
  ): Promise<ConsignmentWire> {
    assertBranchAccess(user, dto.from_branch_id);
    if (dto.from_branch_id === dto.to_branch_id) {
      throw new UnprocessableEntityException(
        'A consignment must move between two different branches',
      );
    }

    const branches = await this.prisma.branch.findMany({
      where: { id: { in: [dto.from_branch_id, dto.to_branch_id] } },
      select: { id: true, code: true },
    });
    if (branches.length !== 2) {
      throw new UnprocessableEntityException(
        'from_branch_id and to_branch_id must both be branches of your company',
      );
    }
    const fromCode =
      branches.find((b) => b.id === dto.from_branch_id)?.code ?? 'XXX';

    const consignmentNo = await this.generateNo(
      user.companyId,
      dto.from_branch_id,
      fromCode,
    );

    const created = await this.prisma.consignment.create({
      data: {
        id: randomUUID(),
        companyId: user.companyId,
        consignmentNo,
        // A branch with no pre-printed tote labels gets the manifest number
        // as its label — one less thing to block the first shipment on.
        toteLabel: dto.tote_label?.trim() || consignmentNo,
        fromBranchId: dto.from_branch_id,
        toBranchId: dto.to_branch_id,
        direction: dto.direction,
        status: 'OPEN',
        courierName: dto.courier_name ?? null,
        courierRef: dto.courier_ref ?? null,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });

    if (dto.job_ids?.length) {
      await this.addJobs(created.id, { job_ids: dto.job_ids }, user);
    }
    return this.get(created.id);
  }

  /** POST /consignments/{id}/jobs — pack more devices while the tote is OPEN. */
  async addJobs(
    id: string,
    dto: AddConsignmentJobsDto,
    user: AuthUser,
  ): Promise<ConsignmentWire> {
    const con = await this.loadOpen(id);

    const jobs = await this.prisma.job.findMany({
      where: { id: { in: dto.job_ids }, deletedAt: null },
      select: { id: true, jobNo: true },
    });
    const found = new Set(jobs.map((j) => j.id));
    const missing = dto.job_ids.filter((j) => !found.has(j));
    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `${missing.length} job id(s) do not match a job of your company`,
      );
    }

    // A device can only be in one tote at a time — it is one physical object.
    const alreadyRiding = await this.prisma.consignmentJob.findMany({
      where: {
        jobId: { in: dto.job_ids },
        checkedInAt: null,
        consignment: { status: { in: ['OPEN', 'IN_TRANSIT'] } },
        consignmentId: { not: id },
      },
      include: { consignment: { select: { consignmentNo: true } } },
    });
    if (alreadyRiding.length > 0) {
      const list = alreadyRiding
        .map((r) => r.consignment.consignmentNo)
        .join(', ');
      throw new ConflictException(
        `${alreadyRiding.length} of those devices are already packed in another consignment (${list})`,
      );
    }

    for (const job of jobs) {
      // Idempotent: adding the same job twice is a double-scan at the packing
      // bench, not an error worth failing the whole batch for.
      await this.prisma.consignmentJob.upsert({
        where: { consignmentId_jobId: { consignmentId: id, jobId: job.id } },
        update: {},
        create: {
          id: randomUUID(),
          companyId: con.companyId,
          consignmentId: id,
          jobId: job.id,
          addedById: user.userId,
        },
      });
    }

    return this.get(id);
  }

  /** DELETE /consignments/{id}/jobs/{jobId} — unpack while still OPEN. */
  async removeJob(
    id: string,
    jobId: string,
    _user: AuthUser,
  ): Promise<ConsignmentWire> {
    await this.loadOpen(id);
    await this.prisma.consignmentJob.deleteMany({
      where: { consignmentId: id, jobId },
    });
    return this.get(id);
  }

  /**
   * POST /consignments/{id}/dispatch — seal the tote and hand it to the
   * courier. Also writes the first chain-of-custody scan (HUB_DEPART), so the
   * chain always starts where the tote actually left from.
   */
  async dispatch(
    id: string,
    dto: DispatchConsignmentDto,
    user: AuthUser,
  ): Promise<ConsignmentWire> {
    const con = await this.loadOpen(id);

    const count = await this.prisma.consignmentJob.count({
      where: { consignmentId: id },
    });
    if (count === 0) {
      throw new UnprocessableEntityException(
        'This consignment is empty — pack at least one device before dispatching it',
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.consignment.update({
        where: { id },
        data: {
          status: 'IN_TRANSIT',
          sealedAt: now,
          dispatchedAt: now,
          dispatchedById: user.userId,
          courierName: dto.courier_name ?? con.courierName,
          courierRef: dto.courier_ref ?? con.courierRef,
          waybillNo: dto.waybill_no ?? con.waybillNo,
          updatedById: user.userId,
        },
      });
      await tx.consignmentScan.create({
        data: {
          id: randomUUID(),
          companyId: con.companyId,
          consignmentId: id,
          scanPoint: 'HUB_DEPART',
          location: dto.courier_name ?? null,
          scannedById: user.userId,
          scannedAt: now,
          note: `Sealed and dispatched with ${count} device(s)`,
        },
      });
    });

    return this.get(id);
  }

  /** POST /consignments/{id}/scan — a handler scanned the tote en route. */
  async scan(
    id: string,
    dto: ScanConsignmentDto,
    user: AuthUser,
  ): Promise<ConsignmentWire> {
    const con = await this.prisma.consignment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!con) throw new NotFoundException('Consignment not found');
    if (con.status === 'CANCELLED') {
      throw new ConflictException('This consignment was cancelled');
    }

    await this.prisma.consignmentScan.create({
      data: {
        id: randomUUID(),
        companyId: con.companyId,
        consignmentId: id,
        scanPoint: dto.scan_point,
        location: dto.location ?? null,
        handlerName: dto.handler_name ?? null,
        scannedById: user.userId,
        note: dto.note ?? null,
      },
    });

    return this.get(id);
  }

  /**
   * POST /consignments/{id}/arrive — check the tote in at the destination.
   *
   * Devices listed in `job_ids` are checked off the manifest. Anything on the
   * manifest and NOT in the list stays unchecked and is reported as MISSING —
   * that discrepancy is the entire reason a manifest exists, so the arrival
   * deliberately succeeds and surfaces it rather than refusing and leaving the
   * tote in limbo.
   */
  async arrive(
    id: string,
    dto: ArriveConsignmentDto,
    user: AuthUser,
  ): Promise<ConsignmentWire> {
    const con = await this.prisma.consignment.findFirst({
      where: { id, deletedAt: null },
      include: { jobs: { select: { jobId: true } } },
    });
    if (!con) throw new NotFoundException('Consignment not found');
    if (con.status !== 'IN_TRANSIT') {
      throw new ConflictException(
        `Only a consignment in transit can arrive (this one is ${con.status})`,
      );
    }
    assertBranchAccess(user, con.toBranchId);

    // No explicit list means "everything on the manifest is here" — the common
    // case, and forcing the receiver to re-enter every id would guarantee they
    // stop checking.
    const present = new Set(dto.job_ids ?? con.jobs.map((j) => j.jobId));
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.consignmentJob.updateMany({
        where: { consignmentId: id, jobId: { in: [...present] } },
        data: { checkedInAt: now, checkedInById: user.userId },
      });
      await tx.consignment.update({
        where: { id },
        data: {
          status: 'ARRIVED',
          arrivedAt: now,
          arrivedById: user.userId,
          notes: dto.notes ?? con.notes,
          updatedById: user.userId,
        },
      });
      await tx.consignmentScan.create({
        data: {
          id: randomUUID(),
          companyId: con.companyId,
          consignmentId: id,
          scanPoint:
            con.direction === 'INBOUND_TO_HUB' ? 'HUB_ARRIVE' : 'SPOKE_ARRIVE',
          scannedById: user.userId,
          scannedAt: now,
          note: `Checked in ${present.size} of ${con.jobs.length} device(s)`,
        },
      });
    });

    return this.get(id);
  }

  /** POST /consignments/{id}/cancel — abandon a tote that never left. */
  async cancel(id: string, user: AuthUser): Promise<ConsignmentWire> {
    const con = await this.prisma.consignment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!con) throw new NotFoundException('Consignment not found');
    if (con.status === 'ARRIVED') {
      throw new ConflictException(
        'This consignment has already arrived and cannot be cancelled',
      );
    }
    if (con.status === 'IN_TRANSIT') {
      throw new ConflictException(
        'This consignment is with the courier — record its arrival rather than cancelling it',
      );
    }

    await this.prisma.consignment.update({
      where: { id },
      data: { status: 'CANCELLED', updatedById: user.userId },
    });
    return this.get(id);
  }

  // ------------------------------------------------------------- helpers

  private async loadOpen(id: string) {
    const con = await this.prisma.consignment.findFirst({
      where: { id, deletedAt: null },
    });
    if (!con) throw new NotFoundException('Consignment not found');
    if (con.status !== 'OPEN') {
      throw new ConflictException(
        `This consignment is ${con.status.toLowerCase()} — its contents can no longer be changed`,
      );
    }
    return con;
  }

  /**
   * `CON-{FROM}-{YYYY}-{seq}` via the same atomic MySQL sequence idiom as job
   * numbers (see JobsService.generateJobNo for the full reasoning).
   */
  private async generateNo(
    companyId: string,
    branchId: string,
    branchCode: string,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO consignment_counters
          (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1),
                NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1)`;
      const rows = await tx.$queryRaw<Array<{ seq: bigint }>>`
        SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });
    return `CON-${branchCode}-${year}-${String(seq).padStart(4, '0')}`;
  }
}

function toWire(c: ConsignmentRow): ConsignmentWire {
  const arrived = c.status === 'ARRIVED';
  const jobs: ConsignmentJobWire[] = c.jobs.map((j) => ({
    job_id: j.jobId,
    job_no: j.job.jobNo,
    customer_name: j.job.customer.name,
    device:
      [j.job.device.brand, j.job.device.model].filter(Boolean).join(' ') ||
      'device',
    imei_serial: j.job.device.imeiSerial,
    added_at: j.addedAt.toISOString(),
    checked_in_at: j.checkedInAt?.toISOString() ?? null,
    // Only meaningful once the tote has been received: before that, an
    // unchecked line is simply one that has not arrived yet.
    missing: arrived && j.checkedInAt === null,
  }));

  return {
    id: c.id,
    consignment_no: c.consignmentNo,
    tote_label: c.toteLabel,
    from_branch_id: c.fromBranchId,
    from_branch: c.fromBranch.name,
    to_branch_id: c.toBranchId,
    to_branch: c.toBranch.name,
    direction: c.direction,
    status: c.status,
    courier_name: c.courierName,
    courier_ref: c.courierRef,
    waybill_no: c.waybillNo,
    sealed_at: c.sealedAt?.toISOString() ?? null,
    dispatched_at: c.dispatchedAt?.toISOString() ?? null,
    arrived_at: c.arrivedAt?.toISOString() ?? null,
    job_count: jobs.length,
    missing_count: jobs.filter((j) => j.missing).length,
    notes: c.notes,
    jobs,
    scans: c.scans
      .slice()
      .sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime())
      .map((s) => ({
        id: s.id,
        scan_point: s.scanPoint,
        location: s.location,
        handler_name: s.handlerName,
        scanned_at: s.scannedAt.toISOString(),
        scanned_by: s.scannedById,
        note: s.note,
      })),
  };
}
