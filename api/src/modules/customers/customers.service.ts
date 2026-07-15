import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerType, Prisma, type Customer } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { normalizePhone } from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateCustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

/** Wire shape of one customer (snake_case per API convention). */
export interface CustomerWire {
  id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  alt_phone: string | null;
  email: string | null;
  location: string | null;
  type: CustomerType;
  dealer_name: string | null;
  is_dealer: boolean;
  preferred_branch_id: string | null;
  preferred_language: string;
  rating: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A money total in one currency (minor-unit string) — computed, never stored. */
export interface MoneyByCurrency {
  currency: string;
  amount: string;
}
export interface CustomerProfileWire {
  customer: CustomerWire;
  stats: {
    total_jobs: number;
    active_jobs: number;
    total_devices: number;
    total_invoices: number;
    /** Σ payments across the customer's invoices, per currency. */
    lifetime_spend: MoneyByCurrency[];
    /** Σ (invoice total − paid) for DRAFT/PARTIAL invoices, per currency. */
    outstanding: MoneyByCurrency[];
    warranty_claims: number;
    warranty_reimbursed_usd: string;
    first_seen: string | null;
    last_visit: string | null;
  };
  devices: Array<{
    id: string;
    brand: string;
    model: string | null;
    category: string;
    imei_serial: string | null;
    color: string | null;
  }>;
  jobs: Array<{
    id: string;
    job_no: string;
    state_code: string;
    state_label: string;
    is_terminal: boolean;
    warranty_status: string;
    device_model: string | null;
    received_at: string;
  }>;
  invoices: Array<{
    id: string;
    invoice_no: string;
    type: string;
    currency: string;
    total: string;
    balance: string;
    status: string;
    created_at: string;
  }>;
  warranty: Array<{
    id: string;
    claim_no: string | null;
    status: string;
    claim_amount_usd: string;
    reimbursed_amount_usd: string | null;
    created_at: string;
  }>;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Customers (Task 1.1, DESIGN.md §4.2 / E2). COMPANY-scoped via the Prisma
 * scope extension — deliberately NOT branch-scoped: a customer can be served
 * at any branch; preferred_branch_id is a CRM preference, not an access
 * boundary (see company-scope.extension.ts). Mutations audited
 * automatically (Customer ∈ AUDITED_MODELS).
 *
 * Phones are stored raw AND normalized (normalizePhone → '+255…') so search
 * hits regardless of the input format ('0765…', '+255…', '7.53848445E8').
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /customers — paginated; `q` matches name OR normalized phone. */
  async list(
    query: CustomerListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<CustomerWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId set explicitly AND re-tightened by the scope extension.
    const where: Prisma.CustomerWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.branch_id ? { preferredBranchId: query.branch_id } : {}),
      ...(query.q ? { OR: searchClauses(query.q) } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /customers/{id}. */
  async get(id: string): Promise<CustomerWire> {
    return toWire(await this.getRow(id));
  }

  /** Scoped row lookup shared with the devices sub-resource (clean 404). */
  async getRow(id: string): Promise<Customer> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /**
   * GET /customers/{id}/profile — the Customer 360 (E2). Assembled from related
   * tables; lifetime spend and outstanding balance are COMPUTED here (never
   * stored, so they can't drift). Branch-scoped users see only their branch's
   * jobs/invoices/claims for the customer (the scope extension filters those),
   * which is the correct per-branch 360; group users see everything.
   */
  async getProfile(id: string): Promise<CustomerProfileWire> {
    const customer = await this.getRow(id);

    const [devices, jobs, invoices, warranty] = await Promise.all([
      this.prisma.device.findMany({
        where: { customerId: id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.job.findMany({
        where: { customerId: id, deletedAt: null },
        include: { state: true, device: { select: { model: true } } },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.invoice.findMany({
        where: { customerId: id, deletedAt: null },
        include: { payments: { select: { amount: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.warrantyClaim.findMany({
        where: { job: { customerId: id }, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    // Per-currency lifetime spend (Σ payments) and outstanding (Σ unpaid balance).
    const spend = new Map<string, bigint>();
    const outstanding = new Map<string, bigint>();
    for (const inv of invoices) {
      const paid = inv.payments.reduce((s, p) => s + p.amount, 0n);
      if (paid > 0n) spend.set(inv.currency, (spend.get(inv.currency) ?? 0n) + paid);
      if (inv.status === 'DRAFT' || inv.status === 'PARTIAL') {
        const bal = inv.total - paid;
        if (bal > 0n)
          outstanding.set(inv.currency, (outstanding.get(inv.currency) ?? 0n) + bal);
      }
    }
    const warrantyReimbursed = warranty.reduce(
      (s, c) => s + (c.reimbursedAmountUsd ?? 0n),
      0n,
    );

    // first/last activity across jobs + invoices.
    const dates = [
      ...jobs.map((j) => j.receivedAt.getTime()),
      ...invoices.map((i) => i.createdAt.getTime()),
    ];
    const first = dates.length ? new Date(Math.min(...dates)) : null;
    const last = dates.length ? new Date(Math.max(...dates)) : null;

    const toMoney = (m: Map<string, bigint>): MoneyByCurrency[] =>
      [...m.entries()].map(([currency, amount]) => ({
        currency,
        amount: amount.toString(),
      }));

    return {
      customer: toWire(customer),
      stats: {
        total_jobs: jobs.length,
        active_jobs: jobs.filter((j) => !j.state.isTerminal).length,
        total_devices: devices.length,
        total_invoices: invoices.filter((i) => i.status !== 'VOID').length,
        lifetime_spend: toMoney(spend),
        outstanding: toMoney(outstanding),
        warranty_claims: warranty.length,
        warranty_reimbursed_usd: warrantyReimbursed.toString(),
        first_seen: first ? first.toISOString() : null,
        last_visit: last ? last.toISOString() : null,
      },
      devices: devices.map((d) => ({
        id: d.id,
        brand: d.brand,
        model: d.model,
        category: d.category,
        imei_serial: d.imeiSerial,
        color: d.color,
      })),
      jobs: jobs.map((j) => ({
        id: j.id,
        job_no: j.jobNo,
        state_code: j.state.code,
        state_label: j.state.label,
        is_terminal: j.state.isTerminal,
        warranty_status: j.warrantyStatus,
        device_model: j.device.model,
        received_at: j.receivedAt.toISOString(),
      })),
      invoices: invoices.map((inv) => {
        const paid = inv.payments.reduce((s, p) => s + p.amount, 0n);
        return {
          id: inv.id,
          invoice_no: inv.invoiceNo,
          type: inv.type,
          currency: inv.currency,
          total: inv.total.toString(),
          balance: (inv.total - paid).toString(),
          status: inv.status,
          created_at: inv.createdAt.toISOString(),
        };
      }),
      warranty: warranty.map((c) => ({
        id: c.id,
        claim_no: c.claimNo,
        status: c.status,
        claim_amount_usd: c.claimAmountUsd.toString(),
        reimbursed_amount_usd: c.reimbursedAmountUsd?.toString() ?? null,
        created_at: c.createdAt.toISOString(),
      })),
    };
  }

  /** POST /customers — phones normalized on save. */
  async create(dto: CreateCustomerDto, user: AuthUser): Promise<CustomerWire> {
    await this.assertBranchInCompany(dto.preferred_branch_id);

    const customer = await this.prisma.customer.create({
      data: {
        companyId: user.companyId, // also force-injected by the extension
        name: dto.name,
        phone: dto.phone ?? null,
        phoneNormalized: normalizePhone(dto.phone),
        altPhone: dto.alt_phone ?? null,
        altPhoneNormalized: normalizePhone(dto.alt_phone),
        email: dto.email ?? null,
        location: dto.location ?? null,
        ...resolveType(dto.type, dto.is_dealer),
        dealerName: dto.dealer_name ?? null,
        preferredBranchId: dto.preferred_branch_id ?? null,
        preferredLanguage: dto.preferred_language ?? 'EN',
        rating: dto.rating ?? null,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });
    return toWire(customer);
  }

  /** PATCH /customers/{id} — re-normalizes any phone being changed. */
  async update(
    id: string,
    dto: UpdateCustomerDto,
    user: AuthUser,
  ): Promise<CustomerWire> {
    await this.getRow(id); // clean 404 (scope extension pins the read)
    await this.assertBranchInCompany(dto.preferred_branch_id);

    const customer = await this.prisma.customer.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.phone !== undefined
          ? { phone: dto.phone, phoneNormalized: normalizePhone(dto.phone) }
          : {}),
        ...(dto.alt_phone !== undefined
          ? {
              altPhone: dto.alt_phone,
              altPhoneNormalized: normalizePhone(dto.alt_phone),
            }
          : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.dealer_name !== undefined
          ? { dealerName: dto.dealer_name }
          : {}),
        // `type` is authoritative; keep the legacy `is_dealer` path for callers
        // that still send only the boolean.
        ...(dto.type !== undefined
          ? resolveType(dto.type, undefined)
          : dto.is_dealer !== undefined
            ? resolveType(undefined, dto.is_dealer)
            : {}),
        ...(dto.preferred_branch_id !== undefined
          ? { preferredBranchId: dto.preferred_branch_id }
          : {}),
        ...(dto.preferred_language !== undefined
          ? { preferredLanguage: dto.preferred_language }
          : {}),
        ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        updatedById: user.userId,
      },
    });
    return toWire(customer);
  }

  /**
   * preferred_branch_id must resolve WITHIN the caller's company — the scope
   * extension pins the read, so a foreign branch id simply doesn't exist.
   */
  private async assertBranchInCompany(branchId?: string): Promise<void> {
    if (!branchId) return;
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) {
      throw new BadRequestException(
        'preferred_branch_id does not match a branch of your company',
      );
    }
  }
}

/**
 * `q` search: name (substring) or phone. The query is normalized with the
 * SAME function used on save, so '0765 447 211', '+255765447211' and
 * '7.53848445E8' all hit the one stored canonical form; raw-column matches
 * are kept as a fallback for partially-entered numbers.
 */
function searchClauses(q: string): Prisma.CustomerWhereInput[] {
  const clauses: Prisma.CustomerWhereInput[] = [
    { name: { contains: q } },
    { phone: { contains: q } },
    { altPhone: { contains: q } },
  ];
  const normalized = normalizePhone(q);
  if (normalized) {
    clauses.push(
      { phoneNormalized: { contains: normalized } },
      { altPhoneNormalized: { contains: normalized } },
    );
  }
  return clauses;
}

/**
 * Resolve the `{ type, isDealer }` pair to persist. `type` wins when given
 * (isDealer derived: DEALER ⇒ true); otherwise fall back to the legacy
 * boolean (is_dealer ⇒ DEALER, else INDIVIDUAL). Returns an empty patch when
 * neither is supplied so an update leaves both columns untouched.
 */
export function resolveType(
  type: CustomerType | undefined,
  isDealer: boolean | undefined,
): { type: CustomerType; isDealer: boolean } | Record<string, never> {
  if (type !== undefined) {
    return { type, isDealer: type === CustomerType.DEALER };
  }
  if (isDealer !== undefined) {
    return {
      type: isDealer ? CustomerType.DEALER : CustomerType.INDIVIDUAL,
      isDealer,
    };
  }
  return {};
}

export function toWire(c: Customer): CustomerWire {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    phone_normalized: c.phoneNormalized,
    alt_phone: c.altPhone,
    email: c.email,
    location: c.location,
    type: c.type,
    dealer_name: c.dealerName,
    is_dealer: c.isDealer,
    preferred_branch_id: c.preferredBranchId,
    preferred_language: c.preferredLanguage,
    rating: c.rating,
    notes: c.notes,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}
