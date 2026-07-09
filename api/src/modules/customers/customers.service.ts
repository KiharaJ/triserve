import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Customer } from '@prisma/client';
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
  dealer_name: string | null;
  is_dealer: boolean;
  preferred_branch_id: string | null;
  preferred_language: string;
  rating: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
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
        dealerName: dto.dealer_name ?? null,
        isDealer: dto.is_dealer ?? false,
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
        ...(dto.is_dealer !== undefined ? { isDealer: dto.is_dealer } : {}),
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

export function toWire(c: Customer): CustomerWire {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    phone_normalized: c.phoneNormalized,
    alt_phone: c.altPhone,
    email: c.email,
    location: c.location,
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
