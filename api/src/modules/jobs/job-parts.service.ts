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
  type JobPartStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import { JobsService } from './jobs.service';

/** Wire shape of one job-part line (snake_case per API convention). */
export interface JobPartWire {
  id: string;
  job_id: string;
  part_id: string;
  part: { part_number: string; description: string; category: DeviceCategory };
  qty: number;
  unit_sell_price: string | null;
  currency: string | null;
  is_warranty: boolean;
  status: JobPartStatus;
  reserved_at: string;
  consumed_at: string | null;
}

interface AddInput {
  part_id: string;
  qty: number;
  unit_sell_price?: string;
  is_warranty?: boolean;
}

type JobPartWithPart = Prisma.JobPartGetPayload<{ include: { part: true } }>;

/**
 * Job parts (Task 2.2, DESIGN.md §4.5) — the bridge between jobs and stock.
 *
 * Adding a part to a job RESERVES branch stock the instant it is committed, so
 * two technicians can never both promise the last unit (available stock drops
 * immediately). Consuming a line fires the CONSUMPTION that removes the unit
 * from on-hand — modelled as an UNRESERVE (release the hold) + a CONSUMPTION
 * (remove the physical unit) so the buckets stay exact. Every stock effect
 * goes through InventoryService.applyMovement (ref_type JOB, ref_id = the job)
 * inside ONE transaction with the job_part row, so a line and its stock effect
 * commit or roll back together. Access is gated through the parent job's
 * company/branch/technician scope (JobsService.loadAccessibleJob).
 */
@Injectable()
export class JobPartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly inventory: InventoryService,
  ) {}

  /** GET /jobs/{id}/parts — the job's committed parts (reserved + consumed). */
  async list(jobId: string, user: AuthUser): Promise<JobPartWire[]> {
    await this.jobs.loadAccessibleJob(jobId, user); // 404 if out of scope
    const lines = await this.prisma.jobPart.findMany({
      where: { jobId },
      include: { part: true },
      orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
    });
    return lines.map(toWire);
  }

  /** POST /jobs/{id}/parts — commit a part, RESERVING branch stock. */
  async add(
    jobId: string,
    input: AddInput,
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);

    const part = await this.resolvePart(input.part_id);

    const unitSellPrice =
      input.unit_sell_price !== undefined
        ? BigInt(input.unit_sell_price)
        : (part.sellPriceTzs ?? null);
    const isWarranty = input.is_warranty ?? job.warrantyStatus === 'IW';

    const created = await this.prisma.$transaction(async (tx) => {
      // RESERVE first — this validates availability and throws 422 if the
      // reservation would push available below zero (nothing else runs then).
      await this.inventory.applyMovement(
        {
          companyId: user.companyId,
          branchId: job.branchId,
          partId: part.id,
          type: 'RESERVE',
          qty: input.qty,
          refType: 'JOB',
          refId: job.id,
          reason: `Reserved for job ${job.jobNo}`,
          movedById: user.userId,
        },
        tx,
      );

      return tx.jobPart.create({
        data: {
          companyId: user.companyId,
          jobId: job.id,
          partId: part.id,
          qty: input.qty,
          unitSellPrice,
          currency: unitSellPrice !== null ? 'TZS' : null,
          isWarranty,
          status: 'RESERVED',
          createdById: user.userId,
          updatedById: user.userId,
        },
        include: { part: true },
      });
    });

    return toWire(created);
  }

  /** DELETE /jobs/{id}/parts/{lineId} — release a RESERVED line (UNRESERVE). */
  async remove(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<{ removed: true }> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);
    const line = await this.loadReservedLine(jobId, lineId);

    await this.prisma.$transaction(async (tx) => {
      await this.inventory.applyMovement(
        {
          companyId: user.companyId,
          branchId: job.branchId,
          partId: line.partId,
          type: 'UNRESERVE',
          qty: -line.qty,
          refType: 'JOB',
          refId: job.id,
          reason: `Released from job ${job.jobNo}`,
          movedById: user.userId,
        },
        tx,
      );
      await tx.jobPart.delete({ where: { id: line.id } });
    });

    return { removed: true };
  }

  /** POST /jobs/{id}/parts/{lineId}/consume — install one RESERVED line. */
  async consumeLine(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);
    const line = await this.loadReservedLine(jobId, lineId);

    const consumed = await this.prisma.$transaction((tx) =>
      this.consumeOne(tx, job.branchId, job.jobNo, line, user),
    );
    return toWire(consumed);
  }

  /**
   * POST /jobs/{id}/parts/consume — install ALL of the job's RESERVED lines in
   * one transaction (the "mark parts used on completion" convenience path).
   */
  async consumeAll(jobId: string, user: AuthUser): Promise<JobPartWire[]> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);

    const reserved = await this.prisma.jobPart.findMany({
      where: { jobId, status: 'RESERVED' },
      include: { part: true },
    });
    if (reserved.length === 0) {
      throw new UnprocessableEntityException(
        'This job has no reserved parts to consume',
      );
    }

    const consumed = await this.prisma.$transaction(async (tx) => {
      const out: JobPartWithPart[] = [];
      for (const line of reserved) {
        out.push(
          await this.consumeOne(tx, job.branchId, job.jobNo, line, user),
        );
      }
      return out;
    });
    return consumed.map(toWire);
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Consume one reserved line inside a caller transaction: release the hold
   * (UNRESERVE) AND remove the physical unit (CONSUMPTION), then flip the line
   * to CONSUMED. Net effect on the buckets: on_hand −qty, reserved −qty, so
   * available is unchanged (it was already reserved out).
   */
  private async consumeOne(
    tx: Prisma.TransactionClient,
    branchId: string,
    jobNo: string,
    line: JobPartWithPart,
    user: AuthUser,
  ): Promise<JobPartWithPart> {
    await this.inventory.applyMovement(
      {
        companyId: user.companyId,
        branchId,
        partId: line.partId,
        type: 'UNRESERVE',
        qty: -line.qty,
        refType: 'JOB',
        refId: line.jobId,
        reason: `Released (consumed) on job ${jobNo}`,
        movedById: user.userId,
      },
      tx,
    );
    await this.inventory.applyMovement(
      {
        companyId: user.companyId,
        branchId,
        partId: line.partId,
        type: 'CONSUMPTION',
        qty: -line.qty,
        refType: 'JOB',
        refId: line.jobId,
        unitCost: line.part.unitCostUsd,
        costCurrency: line.part.unitCostUsd !== null ? 'USD' : null,
        reason: `Consumed on job ${jobNo}`,
        movedById: user.userId,
      },
      tx,
    );
    return tx.jobPart.update({
      where: { id: line.id },
      data: {
        status: 'CONSUMED',
        consumedAt: new Date(),
        updatedById: user.userId,
      },
      include: { part: true },
    });
  }

  private assertMutable(isTerminal: boolean): void {
    if (isTerminal) {
      throw new UnprocessableEntityException(
        'Cannot change parts on a closed/cancelled job',
      );
    }
  }

  /** Load a RESERVED line of this job (404 if missing, 409 if already consumed). */
  private async loadReservedLine(
    jobId: string,
    lineId: string,
  ): Promise<JobPartWithPart> {
    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
      include: { part: true },
    });
    if (!line) throw new NotFoundException('Job part not found');
    if (line.status !== 'RESERVED') {
      throw new ConflictException(
        `This part is already ${line.status.toLowerCase()} and cannot be changed`,
      );
    }
    return line;
  }

  private async resolvePart(
    partId: string,
  ): Promise<{ id: string; sellPriceTzs: bigint | null }> {
    const part = await this.prisma.part.findFirst({
      where: { id: partId, deletedAt: null, active: true },
      select: { id: true, sellPriceTzs: true },
    });
    if (!part) {
      throw new BadRequestException(
        'part_id does not match an active part of your company',
      );
    }
    return part;
  }
}

function toWire(line: JobPartWithPart): JobPartWire {
  return {
    id: line.id,
    job_id: line.jobId,
    part_id: line.partId,
    part: {
      part_number: line.part.partNumber,
      description: line.part.description,
      category: line.part.category,
    },
    qty: line.qty,
    unit_sell_price: line.unitSellPrice?.toString() ?? null,
    currency: line.currency,
    is_warranty: line.isWarranty,
    status: line.status,
    reserved_at: line.reservedAt.toISOString(),
    consumed_at: line.consumedAt?.toISOString() ?? null,
  };
}
