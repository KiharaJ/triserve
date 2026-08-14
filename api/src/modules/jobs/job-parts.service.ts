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
import { ApprovalsService } from '../approvals/approvals.service';
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
  /** NULL until an approver reserves it — a request holds no stock. */
  reserved_at: string | null;
  consumed_at: string | null;

  // -- The bench request → approval → hand-over trail ------------------------
  requested_at: string;
  requested_by: string | null;
  request_note: string | null;
  /** The parts clerk who raised it for approval. */
  issue_requested_at: string | null;
  issue_requested_by: string | null;
  /** The `approvals` row this line is gated on (visible in the inbox). */
  approval_id: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  /** The technician's confirmation that the part reached them. */
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  /** Derived: asked for but not yet in the technician's hands. */
  awaiting_receipt: boolean;

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
  /** Why the bench needs it — shown to whoever decides the request. */
  request_note?: string;
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
 * THE BENCH REQUEST FLOW
 *
 *   REQUESTED  technician asks for a part off the back of their diagnosis.
 *              Nothing is held and no approval is raised yet: an unapproved
 *              request must never lock stock another job could use, and a
 *              wrong part number must never reach a manager's queue.
 *   ISSUE_REQUESTED
 *              the parts clerk checked it against the shelf and raised it for
 *              approval — THIS is what creates the `approvals` row, so the
 *              approver's inbox only holds requests stores has vetted. A clerk
 *              who spots a wrong or unstocked part declines it back to the
 *              bench instead.
 *   RESERVED   an approver said yes — and THAT is what fires the RESERVE
 *              movement. Approving can therefore fail (422) when the part has
 *              gone since the request, which is exactly why approval is an
 *              explicit action here rather than a silent side effect of the
 *              generic approvals inbox. See `approve`.
 *   ISSUED     stores picked it and physically handed it over, tagging the new
 *              part's serial. Custody, not stock: it is already reserved to
 *              this job and is not gone until it is fitted.
 *   ACKNOWLEDGED the technician confirmed it reached them. Closes the gap
 *              between "stores says it handed over" and "the bench has it",
 *              and is what the `parts_received` guard waits for before the job
 *              may leave AWAITING_PARTS for IN_REPAIR.
 *   CONSUMED   fitted — UNRESERVE (release the hold) + CONSUMPTION (remove the
 *              physical unit) so the buckets stay exact.
 *   REJECTED   the approver declined, with a reason the bench can read.
 *
 * Every stock effect goes through InventoryService.applyMovement (ref_type
 * JOB, ref_id = the job) inside ONE transaction with the job_part row, so a
 * line and its stock effect commit or roll back together. Access is gated
 * through the parent job's company/branch/technician scope
 * (JobsService.loadAccessibleJob).
 */
@Injectable()
export class JobPartsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly inventory: InventoryService,
    private readonly approvals: ApprovalsService,
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

  /**
   * POST /jobs/{id}/parts — the technician ASKS for a part.
   *
   * Deliberately reserves nothing. Availability is reported back so the bench
   * knows whether to expect a quick hand-over or a wait, but the stock is not
   * touched until an approver says yes — otherwise an unapproved request would
   * lock a unit another job could have used.
   */
  async request(
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
    // bin. Snapshotted here so a ticket printed later still reads true if the
    // shelf is re-labelled in the meantime.
    const stock = await this.prisma.inventory.findFirst({
      where: { branchId: job.branchId, partId: part.id },
      select: { binLocation: true },
    });

    // Stamped from application time, never the column default: the database
    // host clock runs behind the app, and a request that claims to predate the
    // job would corrupt every queue sorted by age.
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      return tx.jobPart.create({
        data: {
          companyId: user.companyId,
          jobId: job.id,
          partId: part.id,
          qty: input.qty,
          unitSellPrice,
          currency: unitSellPrice !== null ? 'TZS' : null,
          isWarranty,
          status: 'REQUESTED',
          requestedAt: now,
          requestedById: user.userId,
          requestNote: input.request_note?.trim() || null,
          pickBinLocation: stock?.binLocation ?? null,
          // FROZEN on the line, deliberately: re-classifying the catalogue
          // later must not retroactively block — or newly unblock — a job
          // already in flight. What was true when the part was asked for is
          // what the interlock enforces.
          coreRequired: part.requiresCoreReturn,
          createdById: user.userId,
          updatedById: user.userId,
        },
        include: { part: true },
      });
    });

    // No approval is raised here on purpose: the parts clerk vets the request
    // against the shelf first and decides what actually reaches a manager
    // (see `raiseIssueRequest`). Putting every bench request straight into an
    // approver's queue would bury real decisions under wrong-part typos.
    return toWire(created);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/issue-request — the parts clerk picks up a
   * bench request and puts it in front of an approver.
   *
   * This is where the `approvals` row is raised, so the approver's queue only
   * ever contains requests stores has already looked at. The clerk is also the
   * first person positioned to catch a wrong part number or something that
   * simply is not stocked — those get bounced back with `declineRequest`
   * rather than wasting a manager's decision.
   */
  async raiseIssueRequest(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const line = await this.loadLineInStatus(
      jobId,
      lineId,
      ['REQUESTED'],
      'Only a line the bench has requested can be raised for approval',
    );
    const part = await this.resolvePart(line.partId);
    const now = new Date();

    const approval = await this.approvals.request('PARTS_REQUEST', {
      branchId: job.branchId,
      refType: 'JobPart',
      refId: line.id,
      payload: {
        job_id: job.id,
        job_no: job.jobNo,
        part_id: part.id,
        part_number: part.partNumber,
        description: part.description,
        qty: line.qty,
        is_warranty: line.isWarranty,
        requested_by: line.requestedById,
        request_note: line.requestNote,
      },
      reason:
        line.requestNote?.trim() ||
        `Parts issue request for job ${job.jobNo}: ${line.qty} × ${part.partNumber}`,
    });

    const updated = await this.prisma.jobPart.update({
      where: { id: line.id },
      data: {
        status: 'ISSUE_REQUESTED',
        issueRequestedAt: now,
        issueRequestedById: user.userId,
        approvalId: approval.id,
        updatedById: user.userId,
      },
      include: { part: true },
    });
    return toWire(updated);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/decline — the parts clerk bounces a bench
   * request back without troubling an approver (wrong part, not stocked,
   * duplicate of a line already open).
   */
  async declineRequest(
    jobId: string,
    lineId: string,
    reason: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const line = await this.loadLineInStatus(
      jobId,
      lineId,
      ['REQUESTED'],
      'Only a line the bench has requested can be declined by stores',
    );
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to decline');
    }

    const updated = await this.prisma.jobPart.update({
      where: { id: line.id },
      data: {
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectedById: user.userId,
        rejectionReason: reason.trim(),
        updatedById: user.userId,
      },
      include: { part: true },
    });
    return toWire(updated);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/approve — the approver says yes, and the
   * stock is reserved in the same breath.
   *
   * Decided HERE rather than through the generic approvals inbox because the
   * reservation can fail: between the request and the decision the last unit
   * may have gone to another job. The approver has to see that, so it must be
   * a failable call, not a notification. The generic inbox still lists the
   * request — it just refuses to decide it (see ApprovalsService.decide).
   */
  async approve(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const line = await this.loadLineInStatus(
      jobId,
      lineId,
      ['ISSUE_REQUESTED'],
      'Only a line stores has raised for approval can be approved',
    );
    const now = new Date();

    // The decision first: it validates 'approval.decide', branch access and
    // the double-decide race. If the stock then turns out to be gone, the
    // whole thing rolls back and the request stays PENDING for a retry once
    // stock arrives.
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.inventory.applyMovement(
        {
          companyId: user.companyId,
          branchId: job.branchId,
          partId: line.partId,
          type: 'RESERVE',
          qty: line.qty,
          refType: 'JOB',
          refId: job.id,
          reason: `Approved for job ${job.jobNo}`,
          movedById: user.userId,
        },
        tx,
      );
      return tx.jobPart.update({
        where: { id: line.id },
        data: {
          status: 'RESERVED',
          reservedAt: now,
          approvedAt: now,
          approvedById: user.userId,
          updatedById: user.userId,
        },
        include: { part: true },
      });
    });

    if (line.approvalId) {
      await this.approvals.decide(
        line.approvalId,
        'APPROVED',
        user,
        undefined,
        {
          fromOwningService: true,
        },
      );
    }
    return toWire(updated);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/reject — decline the request, with a reason
   * the bench can act on. Nothing to release: a REQUESTED line never held any
   * stock.
   */
  async reject(
    jobId: string,
    lineId: string,
    reason: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const line = await this.loadLineInStatus(
      jobId,
      lineId,
      ['ISSUE_REQUESTED'],
      'Only a line stores has raised for approval can be rejected',
    );
    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to reject');
    }
    const now = new Date();

    const updated = await this.prisma.jobPart.update({
      where: { id: line.id },
      data: {
        status: 'REJECTED',
        rejectedAt: now,
        rejectedById: user.userId,
        rejectionReason: reason.trim(),
        updatedById: user.userId,
      },
      include: { part: true },
    });

    if (line.approvalId) {
      await this.approvals.decide(
        line.approvalId,
        'REJECTED',
        user,
        reason.trim(),
        { fromOwningService: true },
      );
    }
    return toWire(updated);
  }

  /**
   * POST /jobs/{id}/parts/{lineId}/acknowledge — the technician confirms the
   * part is physically in their hands.
   *
   * Separate from `issue` on purpose: issuing is what STORES asserts, and a
   * hand-over recorded by the person giving the part away is not evidence the
   * person receiving it got it. This is the other half, and it is what the
   * `parts_received` guard waits for before the job may start repair.
   */
  async acknowledge(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<JobPartWire> {
    await this.jobs.loadAccessibleJob(jobId, user);
    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
    });
    if (!line) {
      throw new NotFoundException('Job part line not found');
    }
    if (line.status !== 'ISSUED') {
      throw new ConflictException(
        `Only an ISSUED line can be acknowledged (status=${line.status})`,
      );
    }

    const updated = await this.prisma.jobPart.update({
      where: { id: line.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: new Date(),
        acknowledgedById: user.userId,
        updatedById: user.userId,
      },
      include: { part: true },
    });
    return toWire(updated);
  }

  /** Load a line and assert it is in one of the states this step accepts. */
  private async loadLineInStatus(
    jobId: string,
    lineId: string,
    allowed: JobPartStatus[],
    message: string,
  ) {
    const line = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
    });
    if (!line) {
      throw new NotFoundException('Job part line not found');
    }
    if (!allowed.includes(line.status)) {
      throw new ConflictException(`${message} (status=${line.status})`);
    }
    return line;
  }

  /**
   * DELETE /jobs/{id}/parts/{lineId} — withdraw a request, or release a
   * RESERVED line (UNRESERVE).
   *
   * A REQUESTED line never held stock, so withdrawing it is just a deletion
   * plus cancelling the pending approval — no movement to reverse.
   */
  async remove(
    jobId: string,
    lineId: string,
    user: AuthUser,
  ): Promise<{ removed: true }> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    this.assertMutable(job.state.isTerminal);

    const pending = await this.prisma.jobPart.findFirst({
      where: { id: lineId, jobId },
    });
    if (pending?.status === 'REQUESTED') {
      await this.prisma.jobPart.delete({ where: { id: pending.id } });
      if (pending.approvalId) {
        await this.approvals.decide(
          pending.approvalId,
          'REJECTED',
          user,
          'Request withdrawn by the bench',
          { fromOwningService: true },
        );
      }
      return { removed: true };
    }

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

    // ISSUED and ACKNOWLEDGED lines are included: a part picked from its bin,
    // handed over and signed for is exactly a part about to be fitted, and
    // "consume everything on completion" that skipped them would leave the
    // stock ledger permanently wrong. REQUESTED lines are NOT included — they
    // hold no stock, so there is nothing to consume.
    const reserved = await this.prisma.jobPart.findMany({
      where: { jobId, status: { in: ['RESERVED', 'ISSUED', 'ACKNOWLEDGED'] } },
      include: { part: true },
    });
    if (reserved.length === 0) {
      throw new UnprocessableEntityException(
        'This job has no reserved parts to consume — a request must be approved before it can be fitted',
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
    // ACKNOWLEDGED is the normal pre-fitting state now that stores hands over
    // explicitly; RESERVED and ISSUED remain open because a cheap consumable
    // can be fitted without waiting on the full hand-over ceremony. REQUESTED
    // is NOT open: nothing has been reserved, so there is nothing to consume.
    const open: JobPartStatus[] = ['RESERVED', 'ISSUED', 'ACKNOWLEDGED'];
    if (!open.includes(line.status)) {
      throw new ConflictException(
        line.status === 'REQUESTED'
          ? 'This part has not been approved yet — it holds no stock and cannot be fitted'
          : `This part is already ${line.status.toLowerCase()} and cannot be changed`,
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
    if (line.status === 'ISSUED' || line.status === 'ACKNOWLEDGED') {
      throw new ConflictException(
        'This part has already been issued to the bench — it must be returned to the store before the line can be removed',
      );
    }
    return line;
  }

  private async resolvePart(partId: string): Promise<{
    id: string;
    partNumber: string;
    description: string;
    sellPriceTzs: bigint | null;
    requiresCoreReturn: boolean;
    isSerialized: boolean;
  }> {
    const part = await this.prisma.part.findFirst({
      where: { id: partId, deletedAt: null, active: true },
      select: {
        id: true,
        // Snapshotted into the approval payload so the approver reads a part
        // number, not a UUID, without a second query.
        partNumber: true,
        description: true,
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
    reserved_at: line.reservedAt?.toISOString() ?? null,
    consumed_at: line.consumedAt?.toISOString() ?? null,
    requested_at: line.requestedAt.toISOString(),
    requested_by: line.requestedById,
    request_note: line.requestNote,
    issue_requested_at: line.issueRequestedAt?.toISOString() ?? null,
    issue_requested_by: line.issueRequestedById,
    approval_id: line.approvalId,
    approved_at: line.approvedAt?.toISOString() ?? null,
    approved_by: line.approvedById,
    rejected_at: line.rejectedAt?.toISOString() ?? null,
    rejected_by: line.rejectedById,
    rejection_reason: line.rejectionReason,
    acknowledged_at: line.acknowledgedAt?.toISOString() ?? null,
    acknowledged_by: line.acknowledgedById,
    // What the bench is still waiting on: asked for but not yet in hand.
    // Mirrors the `parts_received` guard exactly.
    awaiting_receipt: (
      ['REQUESTED', 'ISSUE_REQUESTED', 'RESERVED', 'ISSUED'] as JobPartStatus[]
    ).includes(line.status),
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
