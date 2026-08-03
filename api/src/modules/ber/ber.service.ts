import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type BerOutcome,
  type BerStatus,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { JobsService } from '../jobs/jobs.service';
import type {
  BerListQueryDto,
  BerOutcomeDto,
  CertifyBerDto,
  EvaluateBerDto,
  RejectBerDto,
} from './dto/ber.dto';

/**
 * Beyond Economic Repair (SCMS proposal Module 4, §5).
 *
 * "If (Total Cost of Estimated SKU Parts + Estimated Labor Cost) >= 70% of the
 * Device's current Fair Commercial Market Value, the system halts the standard
 * track and fires a BER Warning flag."
 *
 * The threshold is per company (`companies.ber_threshold_percent`, default 70)
 * because the economics differ by market — a handset worth TZS 200,000 in Dar
 * is not the same repair decision as the same model elsewhere.
 *
 * Once FLAGGED the technician is locked out (`jobs.tech_locked`) and ownership
 * transfers to the Workshop Supervisor, exactly as §5 step 2 requires. The
 * `ber_not_blocking` workflow guard stops the job creeping forward on the
 * repair track in the meantime.
 *
 * EVERY INPUT IS SNAPSHOTTED on the assessment row. A certificate is a
 * document the manufacturer may audit years later; re-pricing a part next
 * month must not silently change what the supervisor signed.
 */

export interface BerAssessmentWire {
  id: string;
  job_id: string;
  job_no: string;
  branch_id: string;
  certificate_no: string | null;
  parts_cost: string;
  labour_cost: string;
  total_cost: string;
  device_value: string;
  currency: string;
  ratio_percent: string;
  threshold_percent: number;
  valuation_source: string;
  status: BerStatus;
  /** True when the ratio met or exceeded the threshold. */
  breached: boolean;
  flagged_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_notes: string | null;
  outcome: BerOutcome | null;
  offer_amount: string | null;
  customer_responded_at: string | null;
}

/** A dry-run evaluation — the numbers, with nothing written. */
export interface BerPreviewWire {
  job_id: string;
  parts_cost: string;
  labour_cost: string;
  total_cost: string;
  device_value: string;
  currency: string;
  ratio_percent: string;
  threshold_percent: number;
  breached: boolean;
  valuation_source: string;
  /** Human explanation of where each figure came from. */
  basis: string[];
}

export interface EvaluateResult {
  preview: BerPreviewWire;
  /** Written only when the threshold was breached and this was not a dry run. */
  assessment: BerAssessmentWire | null;
}

export interface CertifyResult {
  held: boolean;
  assessment: BerAssessmentWire | null;
  pending_approval?: ApprovalEntry;
}

const DEFAULT_PAGE_SIZE = 25;

@Injectable()
export class BerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
  ) {}

  // ------------------------------------------------------------- evaluate

  /**
   * POST /jobs/{id}/ber/evaluate — run the formula (§5 step 1).
   *
   * Below the threshold nothing is written: a repair that is economic is not
   * an event. At or above it, an assessment is raised in FLAGGED and the bench
   * is locked out.
   */
  async evaluate(
    jobId: string,
    dto: EvaluateBerDto,
    user: AuthUser,
  ): Promise<EvaluateResult> {
    const job = await this.jobs.loadAccessibleJob(jobId, user);
    const preview = await this.computeRatio(jobId, dto, user);

    if (dto.dry_run || !preview.breached) {
      return { preview, assessment: null };
    }

    // An open assessment already covers this job — don't stack duplicates
    // every time somebody re-runs the numbers. Supersede instead, so the
    // latest figures are the ones the supervisor reviews.
    const open = await this.prisma.berAssessment.findFirst({
      where: { jobId, status: 'FLAGGED' },
      orderBy: { flaggedAt: 'desc' },
    });
    if (open) {
      await this.prisma.berAssessment.update({
        where: { id: open.id },
        data: { status: 'WITHDRAWN', updatedById: user.userId },
      });
    }

    const row = await this.prisma.berAssessment.create({
      data: {
        id: randomUUID(),
        companyId: job.companyId,
        branchId: job.branchId,
        jobId,
        partsCost: BigInt(preview.parts_cost),
        labourCost: BigInt(preview.labour_cost),
        totalCost: BigInt(preview.total_cost),
        deviceValue: BigInt(preview.device_value),
        currency: preview.currency,
        ratioPercent: new Prisma.Decimal(preview.ratio_percent),
        thresholdPercent: preview.threshold_percent,
        valuationSource: preview.valuation_source,
        status: 'FLAGGED',
        createdById: user.userId,
        updatedById: user.userId,
      },
      include: { job: { select: { jobNo: true } } },
    });

    // §5 step 2: "The system locks the technician out from making changes and
    // transfers ownership to the Workshop Supervisor."
    await this.prisma.job.update({
      where: { id: jobId },
      data: {
        techLocked: true,
        techLockReason: `Beyond Economic Repair review pending (${preview.ratio_percent}% of device value)`,
        updatedById: user.userId,
      },
    });

    await this.audit.record({
      entityType: 'Job',
      entityId: jobId,
      action: 'UPDATE',
      before: { tech_locked: false },
      after: {
        ber_flagged: true,
        ratio_percent: preview.ratio_percent,
        threshold_percent: preview.threshold_percent,
      },
      companyId: job.companyId,
      branchId: job.branchId,
      actorUserId: user.userId,
    });

    // Tell the customer their device is under review — §5 step 3 makes this a
    // conversation, and it starts sooner if they are told now.
    await this.jobs.notifyJobEvent(jobId, 'BER_NOTICE');

    return { preview, assessment: toWire(row) };
  }

  /**
   * The formula itself, with every figure traced to a source.
   *
   * Parts:  Σ (unit_sell_price × qty) over the job's live part lines, falling
   *         back to the catalogue cost where a line carries no price.
   * Labour: the declared labour hours × the service line's hourly rate is NOT
   *         available (there is no rate table), so labour comes from the OW
   *         invoice's SERVICE lines, then the symptom tree's indicative
   *         estimate, then the caller's override. Whichever was used is named
   *         in `basis` — a ratio nobody can explain is a ratio nobody will
   *         act on.
   * Value:  the device's own override, else the model's catalogue figure, else
   *         the caller's. With none of the three the evaluation cannot run.
   */
  private async computeRatio(
    jobId: string,
    dto: EvaluateBerDto,
    user: AuthUser,
  ): Promise<BerPreviewWire> {
    const job = await this.prisma.job.findFirstOrThrow({
      where: { id: jobId, deletedAt: null },
      select: {
        id: true,
        companyId: true,
        symptomNodeId: true,
        device: {
          select: {
            marketValue: true,
            marketValueCurrency: true,
            deviceModel: {
              select: { marketValue: true, marketValueCurrency: true },
            },
          },
        },
        company: { select: { berThresholdPercent: true, baseCurrency: true } },
      },
    });

    const basis: string[] = [];
    const currency =
      dto.currency ??
      job.device.marketValueCurrency ??
      job.device.deviceModel?.marketValueCurrency ??
      job.company.baseCurrency;

    // -- Parts ---------------------------------------------------------------
    let partsCost: bigint;
    if (dto.parts_cost !== undefined) {
      partsCost = BigInt(dto.parts_cost);
      basis.push('Parts cost supplied by the reviewer');
    } else {
      const lines = await this.prisma.jobPart.findMany({
        where: { jobId, status: { in: ['RESERVED', 'ISSUED', 'CONSUMED'] } },
        include: { part: { select: { sellPriceTzs: true } } },
      });
      partsCost = lines.reduce(
        (sum, l) =>
          sum +
          BigInt(l.qty) * (l.unitSellPrice ?? l.part.sellPriceTzs ?? 0n),
        0n,
      );
      basis.push(
        lines.length > 0
          ? `Parts: ${lines.length} line(s) committed to this job`
          : 'Parts: none committed to this job yet',
      );
    }

    // -- Labour --------------------------------------------------------------
    let labourCost: bigint;
    if (dto.labour_cost !== undefined) {
      labourCost = BigInt(dto.labour_cost);
      basis.push('Labour cost supplied by the reviewer');
    } else {
      const serviceLines = await this.prisma.invoiceLine.findMany({
        where: {
          lineType: 'SERVICE',
          invoice: { jobId, deletedAt: null, status: { not: 'VOID' } },
        },
        select: { lineTotal: true },
      });
      if (serviceLines.length > 0) {
        labourCost = serviceLines.reduce((s, l) => s + l.lineTotal, 0n);
        basis.push(`Labour: ${serviceLines.length} quoted service line(s)`);
      } else if (job.symptomNodeId) {
        const node = await this.prisma.symptomNode.findFirst({
          where: { id: job.symptomNodeId },
          select: { estimateAmount: true, label: true },
        });
        labourCost = node?.estimateAmount ?? 0n;
        basis.push(
          node?.estimateAmount
            ? `Labour: indicative estimate for "${node.label}"`
            : 'Labour: no estimate available (counted as zero)',
        );
      } else {
        labourCost = 0n;
        basis.push('Labour: no quote or estimate available (counted as zero)');
      }
    }

    // -- Device value --------------------------------------------------------
    let deviceValue: bigint;
    let valuationSource: string;
    if (dto.device_value !== undefined) {
      deviceValue = BigInt(dto.device_value);
      valuationSource = 'MANUAL';
      basis.push('Device value supplied by the reviewer');
    } else if (job.device.marketValue !== null) {
      deviceValue = job.device.marketValue;
      valuationSource = 'DEVICE';
      basis.push('Device value: this unit’s own recorded valuation');
    } else if (job.device.deviceModel?.marketValue != null) {
      deviceValue = job.device.deviceModel.marketValue;
      valuationSource = 'MODEL';
      basis.push('Device value: the model’s catalogue valuation');
    } else {
      // Refusing is the honest answer. A default here would produce a
      // certificate that looks authoritative and is founded on a guess.
      throw new UnprocessableEntityException(
        'No market value is recorded for this device or its model — set one on the model, or supply device_value with the evaluation.',
      );
    }

    if (deviceValue <= 0n) {
      throw new UnprocessableEntityException(
        'The device market value must be greater than zero to compute a BER ratio',
      );
    }

    const totalCost = partsCost + labourCost;
    // Integer arithmetic throughout, then one conversion for display: BIGINT
    // minor units must never round-trip through a float.
    const ratio = new Prisma.Decimal(totalCost.toString())
      .div(new Prisma.Decimal(deviceValue.toString()))
      .mul(100)
      .toDecimalPlaces(2);
    const threshold = job.company.berThresholdPercent;

    return {
      job_id: jobId,
      parts_cost: partsCost.toString(),
      labour_cost: labourCost.toString(),
      total_cost: totalCost.toString(),
      device_value: deviceValue.toString(),
      currency,
      ratio_percent: ratio.toString(),
      threshold_percent: threshold,
      breached: ratio.gte(threshold),
      valuation_source: valuationSource,
      basis,
    };
  }

  // -------------------------------------------------------------- decide

  /**
   * POST /ber/{id}/certify (§5 step 2) — the supervisor confirms the device is
   * Beyond Economic Repair and a numbered certificate is issued.
   *
   * Approval-gated (BER_CERTIFICATION): certifying writes off a repair and
   * opens the door to a replacement, which the proposal's matrix reserves to
   * the Centre Manager.
   */
  async certify(
    id: string,
    dto: CertifyBerDto,
    user: AuthUser,
  ): Promise<CertifyResult> {
    const ber = await this.loadOpen(id);

    // §6: "Center Manager … Can approve BER certifications." Whether THIS
    // certification needs that sign-off is a company threshold rule (by value
    // of the write-off), resolved exactly like every other gated action.
    const { required } = await this.approvals.isRequired('BER_CERTIFICATION', {
      amount: ber.totalCost,
    });

    if (required) {
      if (dto.override_approval_id) {
        // An approval already granted for THIS assessment — spend it (single
        // use, stamped with who spent it) and proceed.
        await this.approvals.consumeOverride(
          'BER_CERTIFICATION',
          dto.override_approval_id,
          user,
          { refType: 'BerAssessment', refId: ber.id },
        );
      } else {
        // Nothing is certified yet: raise the request and HOLD. The
        // supervisor's review stands; only the sign-off is outstanding.
        const approval = await this.approvals.request('BER_CERTIFICATION', {
          branchId: ber.branchId,
          refType: 'BerAssessment',
          refId: ber.id,
          payload: {
            job_id: ber.jobId,
            total_cost: ber.totalCost.toString(),
            device_value: ber.deviceValue.toString(),
            ratio_percent: ber.ratioPercent.toString(),
            currency: ber.currency,
          },
          reason: dto.override_reason?.trim() || dto.notes,
        });
        return { held: true, assessment: null, pending_approval: approval };
      }
    }

    const certificateNo = await this.generateCertificateNo(
      ber.companyId,
      ber.branchId,
    );

    const row = await this.prisma.berAssessment.update({
      where: { id },
      data: {
        status: 'CERTIFIED',
        certificateNo,
        reviewedById: user.userId,
        reviewedAt: new Date(),
        decisionNotes: dto.notes,
        updatedById: user.userId,
      },
      include: { job: { select: { jobNo: true } } },
    });

    // The bench stays locked: a certified BER unit is not going back on the
    // repair track. It is unlocked by recording an outcome of REPAIR_ANYWAY,
    // or by the swap/return that resolves the job.
    await this.prisma.job.update({
      where: { id: ber.jobId },
      data: {
        techLockReason: `Certified Beyond Economic Repair (${certificateNo})`,
        updatedById: user.userId,
      },
    });

    return { held: false, assessment: toWire(row) };
  }

  /** POST /ber/{id}/reject — back on the standard repair track. */
  async reject(
    id: string,
    dto: RejectBerDto,
    user: AuthUser,
  ): Promise<BerAssessmentWire> {
    const ber = await this.loadOpen(id);

    const row = await this.prisma.berAssessment.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedById: user.userId,
        reviewedAt: new Date(),
        decisionNotes: dto.notes,
        updatedById: user.userId,
      },
      include: { job: { select: { jobNo: true } } },
    });

    // The review is over, so hand the job back to the bench.
    await this.prisma.job.update({
      where: { id: ber.jobId },
      data: {
        techLocked: false,
        techLockReason: null,
        updatedById: user.userId,
      },
    });

    return toWire(row);
  }

  /**
   * POST /ber/{id}/outcome (§5 step 3) — record the customer's decision.
   *
   * REPAIR_ANYWAY is the one outcome that returns the job to the bench: the
   * proposal allows a customer to insist on a repair they have been advised
   * against, and once they have, the technician needs the job back.
   */
  async recordOutcome(
    id: string,
    dto: BerOutcomeDto,
    user: AuthUser,
  ): Promise<BerAssessmentWire> {
    const ber = await this.prisma.berAssessment.findFirst({ where: { id } });
    if (!ber) throw new NotFoundException('BER assessment not found');
    if (ber.status !== 'CERTIFIED') {
      throw new ConflictException(
        'A customer decision can only be recorded against a CERTIFIED assessment',
      );
    }

    const row = await this.prisma.berAssessment.update({
      where: { id },
      data: {
        outcome: dto.outcome,
        offerAmount: dto.offer_amount ? BigInt(dto.offer_amount) : null,
        customerRespondedAt: new Date(),
        decisionNotes: dto.notes ?? ber.decisionNotes,
        updatedById: user.userId,
      },
      include: { job: { select: { jobNo: true } } },
    });

    if (dto.outcome === 'REPAIR_ANYWAY') {
      await this.prisma.job.update({
        where: { id: ber.jobId },
        data: {
          techLocked: false,
          techLockReason: null,
          updatedById: user.userId,
        },
      });
    }

    await this.audit.record({
      entityType: 'BerAssessment',
      entityId: id,
      action: 'UPDATE',
      before: { outcome: ber.outcome },
      after: { outcome: dto.outcome, offer_amount: dto.offer_amount ?? null },
      companyId: ber.companyId,
      branchId: ber.branchId,
      actorUserId: user.userId,
    });

    return toWire(row);
  }

  // --------------------------------------------------------------- reads

  async list(
    query: BerListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<BerAssessmentWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.BerAssessmentWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.job_id ? { jobId: query.job_id } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.q
        ? {
            OR: [
              { certificateNo: { contains: query.q } },
              { job: { jobNo: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.berAssessment.findMany({
        where,
        include: { job: { select: { jobNo: true } } },
        orderBy: { flaggedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.berAssessment.count({ where }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string): Promise<BerAssessmentWire> {
    const row = await this.prisma.berAssessment.findFirst({
      where: { id },
      include: { job: { select: { jobNo: true } } },
    });
    if (!row) throw new NotFoundException('BER assessment not found');
    return toWire(row);
  }

  /**
   * GET /ber/{id}/certificate — everything the printed certificate shows
   * (§5 step 2: "generates a formal 'BER Certificate' PDF document").
   *
   * Returns the DATA, not a PDF. The web app renders and prints it, exactly as
   * it already does for invoices and receipts — one print pipeline, one place
   * where letterhead and branding live, and no PDF toolchain in the API for a
   * document the browser can produce faithfully.
   */
  async certificate(id: string): Promise<Record<string, unknown>> {
    const row = await this.prisma.berAssessment.findFirst({
      where: { id },
      include: {
        job: {
          select: {
            jobNo: true,
            receivedAt: true,
            faultReported: true,
            techReport: true,
            customer: { select: { name: true, phone: true } },
            device: {
              select: {
                brand: true,
                model: true,
                imeiSerial: true,
                category: true,
              },
            },
          },
        },
        branch: { select: { name: true, address: true, phone: true } },
        company: { select: { name: true, legalName: true, tin: true } },
        reviewedBy: { select: { fullName: true } },
      },
    });
    if (!row) throw new NotFoundException('BER assessment not found');
    if (row.status !== 'CERTIFIED') {
      throw new ConflictException(
        'A certificate exists only for a CERTIFIED assessment',
      );
    }

    return {
      certificate_no: row.certificateNo,
      issued_at: row.reviewedAt?.toISOString() ?? null,
      issued_by: row.reviewedBy?.fullName ?? null,
      company: row.company,
      branch: row.branch,
      job: {
        job_no: row.job.jobNo,
        received_at: row.job.receivedAt.toISOString(),
        fault_reported: row.job.faultReported,
        tech_report: row.job.techReport,
      },
      customer: row.job.customer,
      device: row.job.device,
      assessment: {
        parts_cost: row.partsCost.toString(),
        labour_cost: row.labourCost.toString(),
        total_cost: row.totalCost.toString(),
        device_value: row.deviceValue.toString(),
        currency: row.currency,
        ratio_percent: row.ratioPercent.toString(),
        threshold_percent: row.thresholdPercent,
        valuation_source: row.valuationSource,
      },
      decision_notes: row.decisionNotes,
      outcome: row.outcome,
    };
  }

  // ------------------------------------------------------------- helpers

  private async loadOpen(id: string): Promise<{
    id: string;
    companyId: string;
    branchId: string;
    jobId: string;
    totalCost: bigint;
    deviceValue: bigint;
    ratioPercent: Prisma.Decimal;
    currency: string;
  }> {
    const ber = await this.prisma.berAssessment.findFirst({ where: { id } });
    if (!ber) throw new NotFoundException('BER assessment not found');
    if (ber.status !== 'FLAGGED') {
      throw new ConflictException(
        `This assessment is already ${ber.status.toLowerCase()} — it cannot be decided again`,
      );
    }
    return ber;
  }

  /**
   * `BER-{BRANCH}-{YYYY}-{seq}`, allocated with the same atomic MySQL sequence
   * idiom as job numbers: one `INSERT … ON DUPLICATE KEY UPDATE` using
   * LAST_INSERT_ID as a session-scoped return channel, inside an interactive
   * transaction so the follow-up SELECT reads the same connection's value. The
   * @@unique row lock serialises concurrent allocations.
   */
  private async generateCertificateNo(
    companyId: string,
    branchId: string,
  ): Promise<string> {
    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { id: branchId },
      select: { code: true },
    });
    const year = new Date().getFullYear();

    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO ber_certificate_counters
          (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1),
                NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1)`;
      const rows = await tx.$queryRaw<Array<{ seq: bigint }>>`
        SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });

    return `BER-${branch.code}-${year}-${String(seq).padStart(4, '0')}`;
  }
}

function toWire(
  b: Prisma.BerAssessmentGetPayload<{
    include: { job: { select: { jobNo: true } } };
  }>,
): BerAssessmentWire {
  return {
    id: b.id,
    job_id: b.jobId,
    job_no: b.job.jobNo,
    branch_id: b.branchId,
    certificate_no: b.certificateNo,
    parts_cost: b.partsCost.toString(),
    labour_cost: b.labourCost.toString(),
    total_cost: b.totalCost.toString(),
    device_value: b.deviceValue.toString(),
    currency: b.currency,
    ratio_percent: b.ratioPercent.toString(),
    threshold_percent: b.thresholdPercent,
    valuation_source: b.valuationSource,
    status: b.status,
    breached: b.ratioPercent.gte(b.thresholdPercent),
    flagged_at: b.flaggedAt.toISOString(),
    reviewed_by: b.reviewedById,
    reviewed_at: b.reviewedAt?.toISOString() ?? null,
    decision_notes: b.decisionNotes,
    outcome: b.outcome,
    offer_amount: b.offerAmount?.toString() ?? null,
    customer_responded_at: b.customerRespondedAt?.toISOString() ?? null,
  };
}
