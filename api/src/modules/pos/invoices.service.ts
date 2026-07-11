import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type InvoiceStatus, type InvoiceType } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateInvoiceDto,
  InvoiceLineInput,
  InvoiceListQueryDto,
  UpdateInvoiceDto,
} from './dto/invoice.dto';

const DEFAULT_PAGE_SIZE = 20;

export interface InvoiceLineWire {
  id: string;
  line_type: string;
  part_id: string | null;
  description: string;
  qty: number;
  unit_price: string;
  line_total: string;
  is_warranty: boolean;
}

export interface InvoiceWire {
  id: string;
  invoice_no: string;
  branch_id: string;
  branch_code: string;
  customer_id: string | null;
  customer_name: string | null;
  job_id: string | null;
  job_no: string | null;
  type: InvoiceType;
  currency: string;
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  status: InvoiceStatus;
  sold_by: string;
  notes: string | null;
  created_at: string;
  lines: InvoiceLineWire[];
}

/** Result of a void — applied, or HELD pending approval (§4.11). */
export interface VoidResult {
  held: boolean;
  invoice: InvoiceWire;
  pending_approval?: ApprovalEntry;
}

type InvoiceFull = Prisma.InvoiceGetPayload<{
  include: { branch: true; customer: true; job: true; lines: true };
}>;

const FULL_INCLUDE = {
  branch: true,
  customer: true,
  job: true,
  lines: true,
} as const;

/**
 * Invoicing (Task 3.1, DESIGN.md §4.6) — the sell side.
 *
 * A DRAFT invoice is built with lines (part/product/service/custom); payments
 * (Task 3.2) move it PARTIAL → PAID; a void is approval-gated (INVOICE_VOID).
 * subtotal = Σ line totals, total = subtotal − discount + tax. Company- AND
 * branch-scoped. Not extension-audited (payment/posting touch the status inside
 * a transaction) — the service emits semantic AuditService rows.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(
    query: InvoiceListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<InvoiceWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.InvoiceWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status as InvoiceStatus } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.customer_id ? { customerId: query.customer_id } : {}),
      ...(query.job_id ? { jobId: query.job_id } : {}),
      ...(query.q ? { invoiceNo: { contains: query.q } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<InvoiceWire> {
    void user;
    return toWire(await this.load(id));
  }

  // ---------------------------------------------------------------- mutations

  /** POST /invoices — a DRAFT sale with computed totals. */
  async create(dto: CreateInvoiceDto, user: AuthUser): Promise<InvoiceWire> {
    const branchId = dto.branch_id ?? user.homeBranchId;
    if (!branchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);
    if (dto.customer_id) await this.assertCustomer(dto.customer_id);
    if (dto.job_id) await this.assertJob(dto.job_id);
    await this.assertPartLines(dto.lines);

    const company = await this.prisma.company.findFirstOrThrow({
      where: { id: user.companyId },
      select: { baseCurrency: true },
    });
    const subtotal = lineSubtotal(dto.lines);
    const discount = BigInt(dto.discount ?? '0');
    const tax = BigInt(dto.tax ?? '0');
    if (discount > subtotal) {
      throw new BadRequestException('discount cannot exceed the subtotal');
    }
    const invoiceNo = await this.generateInvoiceNo(
      user.companyId,
      branchId,
      await this.branchCode(branchId),
      new Date().getFullYear(),
    );

    const invoice = await this.prisma.invoice.create({
      data: {
        companyId: user.companyId,
        invoiceNo,
        branchId,
        customerId: dto.customer_id ?? null,
        jobId: dto.job_id ?? null,
        type: dto.type,
        currency: company.baseCurrency,
        subtotal,
        discount,
        tax,
        total: subtotal - discount + tax,
        status: 'DRAFT',
        soldById: user.userId,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
        lines: { create: dto.lines.map(toLineData) },
      },
      include: FULL_INCLUDE,
    });

    await this.recordAudit(invoice, 'CREATE', user, {
      invoice_no: invoiceNo,
      total: invoice.total.toString(),
    });
    return toWire(invoice);
  }

  /** PATCH /invoices/{id} — DRAFT only; lines (if given) replace all. */
  async update(
    id: string,
    dto: UpdateInvoiceDto,
    user: AuthUser,
  ): Promise<InvoiceWire> {
    const invoice = await this.load(id);
    if (invoice.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT invoice can be edited');
    }
    if (dto.customer_id) await this.assertCustomer(dto.customer_id);
    if (dto.lines) await this.assertPartLines(dto.lines);

    const subtotal = dto.lines ? lineSubtotal(dto.lines) : invoice.subtotal;
    const discount =
      dto.discount !== undefined ? BigInt(dto.discount) : invoice.discount;
    const tax = dto.tax !== undefined ? BigInt(dto.tax) : invoice.tax;
    if (discount > subtotal) {
      throw new BadRequestException('discount cannot exceed the subtotal');
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        ...(dto.customer_id !== undefined
          ? { customerId: dto.customer_id }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.discount !== undefined ? { discount } : {}),
        ...(dto.tax !== undefined ? { tax } : {}),
        subtotal,
        total: subtotal - discount + tax,
        updatedById: user.userId,
        ...(dto.lines
          ? { lines: { deleteMany: {}, create: dto.lines.map(toLineData) } }
          : {}),
      },
    });
    return this.get(id, user);
  }

  /**
   * POST /invoices/{id}/void — void an unpaid/partially-paid invoice.
   * Approval-gated by value (INVOICE_VOID): when required, the status is
   * unchanged and a PENDING approval is returned.
   */
  async void(id: string, reason: string, user: AuthUser): Promise<VoidResult> {
    const invoice = await this.load(id);
    if (invoice.status === 'VOID' || invoice.status === 'REFUNDED') {
      throw new ConflictException(`Invoice is already ${invoice.status}`);
    }
    if (invoice.status === 'PAID') {
      throw new ConflictException(
        'A PAID invoice must be refunded, not voided',
      );
    }

    const { required } = await this.approvals.isRequired('INVOICE_VOID', {
      amount: invoice.total,
    });
    if (required) {
      const approval = await this.approvals.request('INVOICE_VOID', {
        branchId: invoice.branchId,
        refType: 'Invoice',
        refId: invoice.id,
        payload: {
          invoice_no: invoice.invoiceNo,
          total: invoice.total.toString(),
        },
        reason,
      });
      return {
        held: true,
        invoice: await this.get(id, user),
        pending_approval: approval,
      };
    }

    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'VOID', updatedById: user.userId },
    });
    await this.recordAudit(invoice, 'UPDATE', user, {
      status: 'VOID',
      reason,
    });
    return { held: false, invoice: await this.get(id, user) };
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<InvoiceFull> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  private async recordAudit(
    invoice: {
      id: string;
      companyId: string;
      branchId: string;
      status: string;
    },
    action: 'CREATE' | 'UPDATE',
    user: AuthUser,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      entityType: 'Invoice',
      entityId: invoice.id,
      action,
      after,
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      actorUserId: user.userId,
    });
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

  private async assertCustomer(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
    });
    if (!customer) {
      throw new BadRequestException(
        'customer_id does not match a customer of your company',
      );
    }
  }

  private async assertJob(jobId: string): Promise<void> {
    const job = await this.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
    });
    if (!job) {
      throw new BadRequestException(
        'job_id does not match a job of your company',
      );
    }
  }

  private async assertPartLines(lines: InvoiceLineInput[]): Promise<void> {
    const partIds = lines
      .filter((l) => l.line_type === 'PART' && l.part_id)
      .map((l) => l.part_id as string);
    if (partIds.length === 0) return;
    const found = await this.prisma.part.findMany({
      where: { id: { in: [...new Set(partIds)] }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== new Set(partIds).size) {
      throw new BadRequestException(
        'One or more part_id on a PART line is invalid',
      );
    }
  }

  private async branchCode(branchId: string): Promise<string> {
    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { id: branchId },
      select: { code: true },
    });
    return branch.code;
  }

  private async generateInvoiceNo(
    companyId: string,
    branchId: string,
    branchCode: string,
    year: number,
  ): Promise<string> {
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO invoice_counters (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1), NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1), updated_at = NOW(3)`;
      const rows = await tx.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });
    return `INV-${branchCode}-${year}-${String(seq).padStart(5, '0')}`;
  }
}

/** Σ line totals (qty × unit_price) in minor units. */
function lineSubtotal(lines: InvoiceLineInput[]): bigint {
  return lines.reduce(
    (sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_price),
    0n,
  );
}

function toLineData(
  l: InvoiceLineInput,
): Prisma.InvoiceLineUncheckedCreateWithoutInvoiceInput {
  const unitPrice = BigInt(l.unit_price);
  return {
    lineType: l.line_type,
    partId: l.line_type === 'PART' ? (l.part_id ?? null) : null,
    description: l.description,
    qty: l.qty,
    unitPrice,
    lineTotal: BigInt(l.qty) * unitPrice,
    isWarranty: l.is_warranty ?? false,
  };
}

function toWire(inv: InvoiceFull): InvoiceWire {
  return {
    id: inv.id,
    invoice_no: inv.invoiceNo,
    branch_id: inv.branchId,
    branch_code: inv.branch.code,
    customer_id: inv.customerId,
    customer_name: inv.customer?.name ?? null,
    job_id: inv.jobId,
    job_no: inv.job?.jobNo ?? null,
    type: inv.type,
    currency: inv.currency,
    subtotal: inv.subtotal.toString(),
    discount: inv.discount.toString(),
    tax: inv.tax.toString(),
    total: inv.total.toString(),
    status: inv.status,
    sold_by: inv.soldById,
    notes: inv.notes,
    created_at: inv.createdAt.toISOString(),
    lines: inv.lines.map((l) => ({
      id: l.id,
      line_type: l.lineType,
      part_id: l.partId,
      description: l.description,
      qty: l.qty,
      unit_price: l.unitPrice.toString(),
      line_total: l.lineTotal.toString(),
      is_warranty: l.isWarranty,
    })),
  };
}
