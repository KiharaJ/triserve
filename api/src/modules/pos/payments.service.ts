import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type Payment, type PaymentMethodType } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type { PaymentListQueryDto, RecordPaymentDto } from './dto/payment.dto';

const DEFAULT_PAGE_SIZE = 20;

/** Wire shape of one payment (snake_case; money as minor-unit strings). */
export interface PaymentWire {
  id: string;
  invoice_id: string;
  method: PaymentMethodType;
  amount: string;
  currency: string;
  reference: string | null;
  paid_at: string;
  received_by: string;
  notes: string | null;
  created_at: string;
}

/** Result of recording a payment — the payment + the invoice's new balance. */
export interface RecordPaymentResult {
  payment: PaymentWire;
  invoice: {
    id: string;
    invoice_no: string;
    status: string;
    total: string;
    amount_paid: string;
    balance: string;
  };
}

/**
 * Payments (Task 3.2, DESIGN.md §4.6). Recording a payment appends a row AND
 * advances the invoice (DRAFT/PARTIAL → PARTIAL → PAID when the running total
 * covers it) in ONE transaction — the deposit → balance → paid pattern.
 * Append-only; company- AND branch-scoped. Not extension-audited (the invoice
 * status moves inside the transaction); a semantic AuditService row is emitted.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** POST /invoices/{invoiceId}/payments. */
  async record(
    invoiceId: string,
    dto: RecordPaymentDto,
    user: AuthUser,
  ): Promise<RecordPaymentResult> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, deletedAt: null },
      include: { payments: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (invoice.status === 'VOID' || invoice.status === 'REFUNDED') {
      throw new ConflictException(`Cannot pay a ${invoice.status} invoice`);
    }
    if (invoice.status === 'PAID') {
      throw new ConflictException('Invoice is already fully paid');
    }
    if (dto.currency && dto.currency.toUpperCase() !== invoice.currency) {
      throw new BadRequestException(
        `Payment currency must be ${invoice.currency}`,
      );
    }

    const amount = BigInt(dto.amount);
    if (amount <= 0n) {
      throw new BadRequestException('amount must be greater than zero');
    }
    const alreadyPaid = invoice.payments.reduce((s, p) => s + p.amount, 0n);
    const balance = invoice.total - alreadyPaid;
    if (amount > balance) {
      throw new UnprocessableEntityException(
        `Payment exceeds the outstanding balance (${balance.toString()})`,
      );
    }

    const newPaid = alreadyPaid + amount;
    const newStatus = newPaid >= invoice.total ? 'PAID' : 'PARTIAL';

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          companyId: invoice.companyId,
          invoiceId: invoice.id,
          branchId: invoice.branchId,
          method: dto.method,
          amount,
          currency: invoice.currency,
          reference: dto.reference ?? null,
          paidAt: dto.paid_at ? new Date(dto.paid_at) : new Date(),
          receivedById: user.userId,
          notes: dto.notes ?? null,
        },
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: newStatus, updatedById: user.userId },
      });
      return created;
    });

    await this.audit.record({
      entityType: 'Payment',
      entityId: payment.id,
      action: 'CREATE',
      after: {
        invoice_no: invoice.invoiceNo,
        method: dto.method,
        amount: amount.toString(),
        invoice_status: newStatus,
      },
      companyId: invoice.companyId,
      branchId: invoice.branchId,
      actorUserId: user.userId,
    });

    return {
      payment: toWire(payment),
      invoice: {
        id: invoice.id,
        invoice_no: invoice.invoiceNo,
        status: newStatus,
        total: invoice.total.toString(),
        amount_paid: newPaid.toString(),
        balance: (invoice.total - newPaid).toString(),
      },
    };
  }

  /** GET /invoices/{id}/payments — the invoice's payment history. */
  async listForInvoice(
    invoiceId: string,
    user: AuthUser,
  ): Promise<PaymentWire[]> {
    void user;
    const rows = await this.prisma.payment.findMany({
      where: { invoiceId },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toWire);
  }

  /** GET /payments — the takings list (day's cash-up), filtered + paginated. */
  async list(
    query: PaymentListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<PaymentWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.PaymentWhereInput = {
      companyId: user.companyId,
      ...(query.invoice_id ? { invoiceId: query.invoice_id } : {}),
      ...(query.method ? { method: query.method } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.from || query.to
        ? {
            paidAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }
}

/** Pure mapper — reused by InvoicesService to embed payments in the invoice. */
export function toWire(p: Payment): PaymentWire {
  return {
    id: p.id,
    invoice_id: p.invoiceId,
    method: p.method,
    amount: p.amount.toString(),
    currency: p.currency,
    reference: p.reference,
    paid_at: p.paidAt.toISOString(),
    received_by: p.receivedById,
    notes: p.notes,
    created_at: p.createdAt.toISOString(),
  };
}
