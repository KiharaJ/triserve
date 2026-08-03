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

  // -- SCMS proposal Module 3: the closed-loop core exchange ----------------
  /** Bin the storekeeper picks it from, snapshotted at reservation. */
  pick_bin_location: string | null;
  /** "Issued to Tech" — physically handed over. */
  issued_at: string | null;
  issued_by: string | null;
  /** The NEW part's tracking serial, tagged to this repair ticket. */
  new_serial_no: string | null;
  part_unit_id: string | null;
  /** True when the OLD unit must come back before the job may reach QC. */
  core_required: boolean;
  /** The OLD unit's serial, scanned into the secure return bin. */
  core_serial_no: string | null;
  core_returned_at: string | null;
  core_returned_by: string | null;
  core_bin_location: string | null;
  /** Derived: this line is still holding the job out of QC. */
  core_outstanding: boolean;
}

interface AddInput {
  part_id: string;
  qty: number;
  unit_sell_price?: string;
  is_warranty?: boolean;
}

/**
 * SCMS proposal Module 3 step 3 — what the storekeeper prints and walks the
 * aisles with.
 */
export interface PickingTicketWire {
  job_id: string;
  job_no: string;
  branch_id: string;
  printed_at: string;
  lines: Array<{
    line_id: string;
    part_id: string;
    part_number: string;
    description: string;
    qty: number;
    /** The LIVE bin, falling back to the snapshot taken at reservation. */
    bin_location: string | null;
    /** True when the part has been re-shelved since it was reserved. */
    bin_moved: boolean;
    core_required: boolean;
    is_serialized: boolean;
  }>;
}

/** SCMS proposal Module 3 step 4 — the defective-return interlock's state. */
export interface CoreStatusWire {
  job_id: string;
  /** True when nothing is outstanding — the job may proceed to QC. */
  clear: boolean;
  outstanding_count: number;
  lines: Array<{
    line_id: string;
    part_number: string;
    description: string;
    qty: number;
    status: JobPartStatus;
    /** "New Part Serial Out" … */
    new_serial_no: string | null;
    /** … versus "Old Part Serial In" — the pair the manufacturer audits. */
    core_serial_no: string | null;
    core_returned_at: string | null;
    outstanding: boolean;
  }>;
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

    // SCMS proposal Module 3, step 3: the picking ticket needs the physical
    // bin. Snapshotted at reservation so a ticket printed today still reads
    // true if the shelf is re-labelled next week.
    const stock = await this.prisma.inventory.findFirst({
      where: { branchId: job.branchId, partId: part.id },
      select: { binLocation: true },
    });

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
          pickBinLocation: stock?.binLocation ?? null,
          // FROZEN on the line, deliberately: re-classifying the catalogue
          // later must not retroactively block — or newly unblock — a job
          // already in flight. What was true when the part was committed is
          // what the interlock enforces.
          coreRequired: part.requiresCoreReturn,
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
    const line = await this.loadOpenLine(jobId, lineId);

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

    // ISSUED lines are included: a core-exchange part picked from its bin and
    // handed to the technician is exactly a part about to be fitted, and
    // "consume everything on completion" that skipped them would leave the
    // stock ledger permanently wrong.
    const reserved = await this.prisma.jobPart.findMany({
      where: { jobId, status: { in: ['RESERVED', 'ISSUED'] } },
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

  // ================= SCMS proposal Module 3 — core exchange =================

  /**
   * GET /jobs/{id}/picking-ticket (proposal §4 step 3).
   *
   * "The warehouse manager prints a picking ticket showing the specific
   * physical Bin Location (e.g. Aisle 3, Shelf B, Box 12)."
   *
   * Lists every line still waiting to be picked, with its bin. Read-only: the
   * state change to "Issued to Tech" happens on physical pickup, via
   * {@link issue}, not by printing a piece of paper.
   */
  async pickingTicket(
    jobId: string,
    user: AuthUser,
  ): Promise<PickingTicketWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);

    const lines = await this.prisma.jobPart.findMany({
      where: { jobId, status: 'RESERVED' },
      include: { part: true },
      orderBy: [{ pickBinLocation: 'asc' }, { reservedAt: 'asc' }],
    });

    // The snapshot on the line is what the ticket promises, but a part that
    // has since MOVED bin would send the picker to an empty shelf. Show the
    // live bin alongside so a re-shelved part is still findable.
    const liveBins = await this.prisma.inventory.findMany({
      where: {
        branchId: job.branchId,
        partId: { in: lines.map((l) => l.partId) },
      },
      select: { partId: true, binLocation: true },
    });
    const liveByPart = new Map(liveBins.map((b) => [b.partId, b.binLocation]));

    return {
      job_id: jobId,
      job_no: job.jobNo,
      branch_id: job.branchId,
      printed_at: new Date().toISOString(),
      lines: lines.map((l) => ({
        line_id: l.id,
        part_id: l.partId,
        part_number: l.part.partNumber,
        description: l.part.description,
        qty: l.qty,
        bin_location: liveByPart.get(l.partId) ?? l.pickBinLocation,
        /** Whether the bin has changed since this line was reserved. */
        bin_moved:
          (liveByPart.get(l.partId) ?? null) !== (l.pickBinLocation ?? null),
        core_required: l.coreRequired,
        is_serialized: l.part.isSerialized,
      })),
    };
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/issue (proposal §4 steps 2–3).
   *
   * "Upon physical pickup, the system updates the state to 'Issued to Tech'."
   * This is also where the NEW part's unique serial is tagged to the repair
   * ticket — the "Serial Out" half of the pair Samsung audits.
   *
   * Stock does NOT move here. The unit is already reserved to this job, and it
   * is not consumed until it is actually fitted; issuing is a custody change,
   * not a stock change. Modelling it as a movement would double-count.
   */
  async issue(
    jobId: string,
    lineId: string,
    input: { serial_no?: string },
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);

    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
      include: { part: true },
    });
    if (!line) throw new NotFoundException('Job part not found');
    if (line.status !== 'RESERVED') {
      throw new ConflictException(
        `This part is already ${line.status.toLowerCase()} — it cannot be issued again`,
      );
    }

    // A serial-tracked part MUST be identified on issue: without it there is
    // no "New Part Serial Out" to reconcile against the core coming back, and
    // the whole 1:1 audit trail the proposal requires has a hole in it.
    const serial = input.serial_no?.trim().toUpperCase() || null;
    if (line.part.isSerialized && !serial) {
      throw new UnprocessableEntityException(
        `${line.part.partNumber} is serial-tracked — scan the new unit's serial number before issuing it`,
      );
    }

    // Link the register unit when the serial is one we know about, and refuse
    // a unit that is already installed elsewhere: two jobs claiming the same
    // physical component is exactly the fraud this register exists to catch.
    let partUnitId: string | null = null;
    if (serial) {
      const unit = await this.prisma.partUnit.findFirst({
        where: { partId: line.partId, serialNo: serial, deletedAt: null },
        select: { id: true, status: true, installedOnJobId: true },
      });
      if (unit) {
        if (unit.installedOnJobId && unit.installedOnJobId !== jobId) {
          throw new ConflictException(
            `Serial ${serial} is already recorded as installed on another job`,
          );
        }
        partUnitId = unit.id;
      }
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (partUnitId) {
        await tx.partUnit.update({
          where: { id: partUnitId },
          data: {
            status: 'RESERVED',
            installedOnJobId: jobId,
            branchId: job.branchId,
            updatedById: user.userId,
          },
        });
      }
      return tx.jobPart.update({
        where: { id: line.id },
        data: {
          status: 'ISSUED',
          issuedAt: now,
          issuedById: user.userId,
          newSerialNo: serial,
          partUnitId,
          updatedById: user.userId,
        },
        include: { part: true },
      });
    });

    return toWire(updated);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/core-return (proposal §4 steps 4–5).
   *
   * "The technician cannot route the device to QC_TESTING until they
   * physically place the old, damaged component into a secure storage bin and
   * scan its unique serial barcode into the system."
   *
   * This is that scan. It:
   *   1. records the OLD serial against the line (the "Serial In" half),
   *   2. books the defective unit into the Scrap/Return Warehouse bucket via a
   *      CORE_RETURN ledger movement — so the return warehouse is derived from
   *      the same append-only ledger as every other stock number,
   *   3. registers the core as a `part_units` row in CORE_RETURNED, giving the
   *      manufacturer audit a per-unit record rather than just a count.
   *
   * All three in ONE transaction: a counted core with no serial, or a serial
   * with no count, would each break the reconciliation the proposal calls
   * "Ledger Balancing".
   */
  async returnCore(
    jobId: string,
    lineId: string,
    input: { core_serial_no: string; bin_location?: string; note?: string },
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);

    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
      include: { part: true },
    });
    if (!line) throw new NotFoundException('Job part not found');
    if (!line.coreRequired) {
      throw new UnprocessableEntityException(
        `${line.part.partNumber} is not a core-exchange part — no defective return is owed`,
      );
    }
    if (line.coreReturnedAt) {
      throw new ConflictException(
        `The core for ${line.part.partNumber} has already been returned (serial ${line.coreSerialNo})`,
      );
    }
    // The core comes OFF the device, so the new part must have gone ON first.
    // Accepting a return before the part is fitted would let a technician
    // clear the interlock and then never do the work.
    if (line.status !== 'ISSUED' && line.status !== 'CONSUMED') {
      throw new UnprocessableEntityException(
        'Issue and fit the replacement part before booking its defective core back in',
      );
    }

    const serial = input.core_serial_no.trim().toUpperCase();
    if (!serial) {
      throw new UnprocessableEntityException(
        'Scan the defective unit’s serial number',
      );
    }
    // The same physical core cannot be handed back twice — the classic way a
    // 1:1 exchange obligation gets quietly discharged with one part.
    const dupe = await this.prisma.jobPart.findFirst({
      where: { coreSerialNo: serial, id: { not: line.id } },
      select: { jobId: true },
    });
    if (dupe) {
      throw new ConflictException(
        `Core serial ${serial} has already been booked in against another job`,
      );
    }

    const bin =
      input.bin_location?.trim() ||
      (
        await this.prisma.inventory.findFirst({
          where: { branchId: job.branchId, partId: line.partId },
          select: { coreBinLocation: true },
        })
      )?.coreBinLocation ||
      null;

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.inventory.applyMovement(
        {
          companyId: user.companyId,
          branchId: job.branchId,
          partId: line.partId,
          type: 'CORE_RETURN',
          qty: line.qty,
          refType: 'JOB',
          refId: jobId,
          unitCost: line.part.unitCostUsd,
          costCurrency: line.part.unitCostUsd !== null ? 'USD' : null,
          reason: `Defective core returned on job ${job.jobNo} (serial ${serial})`,
          movedById: user.userId,
        },
        tx,
      );

      // Register the physical core. Upsert rather than create: a core whose
      // serial is already in the unit register (it was supplied by us
      // originally) should CHANGE STATE, not be duplicated.
      const existing = await tx.partUnit.findFirst({
        where: { partId: line.partId, serialNo: serial },
        select: { id: true },
      });
      if (existing) {
        await tx.partUnit.update({
          where: { id: existing.id },
          data: {
            status: 'CORE_RETURNED',
            removedFromJobId: jobId,
            branchId: job.branchId,
            updatedById: user.userId,
          },
        });
      } else {
        await tx.partUnit.create({
          data: {
            companyId: user.companyId,
            partId: line.partId,
            serialNo: serial,
            branchId: job.branchId,
            status: 'CORE_RETURNED',
            removedFromJobId: jobId,
            createdById: user.userId,
            updatedById: user.userId,
          },
        });
      }

      return tx.jobPart.update({
        where: { id: line.id },
        data: {
          coreSerialNo: serial,
          coreReturnedAt: now,
          coreReturnedById: user.userId,
          coreBinLocation: bin,
          updatedById: user.userId,
        },
        include: { part: true },
      });
    });

    return toWire(updated);
  }

  /**
   * GET /jobs/{id}/core-status — what the job still owes the manufacturer.
   * The same question the `core_returns_complete` guard answers, exposed so
   * the bench sees the interlock before it stops them rather than after.
   */
  async coreStatus(jobId: string, user: AuthUser): Promise<CoreStatusWire> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const lines = await this.prisma.jobPart.findMany({
      where: { jobId, coreRequired: true },
      include: { part: true },
      orderBy: { reservedAt: 'asc' },
    });

    const outstanding = lines.filter(
      (l) => l.status === 'CONSUMED' && l.coreReturnedAt === null,
    );

    return {
      job_id: jobId,
      clear: outstanding.length === 0,
      outstanding_count: outstanding.length,
      lines: lines.map((l) => ({
        line_id: l.id,
        part_number: l.part.partNumber,
        description: l.part.description,
        qty: l.qty,
        status: l.status,
        new_serial_no: l.newSerialNo,
        core_serial_no: l.coreSerialNo,
        core_returned_at: l.coreReturnedAt?.toISOString() ?? null,
        outstanding: l.status === 'CONSUMED' && l.coreReturnedAt === null,
      })),
    };
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

  /**
   * Load an OPEN line of this job — one that may still be consumed.
   *
   * RESERVED and ISSUED both qualify: SCMS proposal Module 3 inserts a
   * picking/handover step between them for core-exchange parts, while a cheap
   * consumable is fitted straight off the shelf without ever being formally
   * issued. Both paths end at CONSUMED.
   */
  private async loadOpenLine(
    jobId: string,
    lineId: string,
  ): Promise<JobPartWithPart> {
    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
      include: { part: true },
    });
    if (!line) throw new NotFoundException('Job part not found');
    if (line.status !== 'RESERVED' && line.status !== 'ISSUED') {
      throw new ConflictException(
        `This part is already ${line.status.toLowerCase()} and cannot be changed`,
      );
    }
    return line;
  }

  /**
   * Load a line that may still be RELEASED back to stock. Stricter than
   * {@link loadOpenLine}: an ISSUED part is physically in the technician's
   * hand, so "un-reserving" it would credit stock that is not on the shelf.
   * It has to come back through a return, not a delete.
   */
  private async loadReservedLine(
    jobId: string,
    lineId: string,
  ): Promise<JobPartWithPart> {
    const line = await this.loadOpenLine(jobId, lineId);
    if (line.status === 'ISSUED') {
      throw new ConflictException(
        'This part has already been issued to the bench — it must be returned to the store before the line can be removed',
      );
    }
    return line;
  }

  private async resolvePart(partId: string): Promise<{
    id: string;
    sellPriceTzs: bigint | null;
    requiresCoreReturn: boolean;
    isSerialized: boolean;
  }> {
    const part = await this.prisma.part.findFirst({
      where: { id: partId, deletedAt: null, active: true },
      select: {
        id: true,
        sellPriceTzs: true,
        requiresCoreReturn: true,
        isSerialized: true,
      },
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
    pick_bin_location: line.pickBinLocation,
    issued_at: line.issuedAt?.toISOString() ?? null,
    issued_by: line.issuedById,
    new_serial_no: line.newSerialNo,
    part_unit_id: line.partUnitId,
    core_required: line.coreRequired,
    core_serial_no: line.coreSerialNo,
    core_returned_at: line.coreReturnedAt?.toISOString() ?? null,
    core_returned_by: line.coreReturnedById,
    core_bin_location: line.coreBinLocation,
    // Only a FITTED part owes a core — a reservation the technician never
    // used has no old unit to give back. Mirrors the guard exactly.
    core_outstanding:
      line.coreRequired &&
      line.status === 'CONSUMED' &&
      line.coreReturnedAt === null,
  };
}
