import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Supplier } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateSupplierDto,
  SupplierListQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';

/** Wire shape of one supplier (snake_case per API convention). */
export interface SupplierWire {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  default_currency: string;
  lead_time_days: number | null;
  payment_terms: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Suppliers (Task 2.5, DESIGN.md §4.4b) — the vendors we buy spares from.
 * Company-level master data like the parts catalogue; parts point at a
 * preferred supplier (Part.preferred_supplier_id). Supplier performance
 * (E9-proc) is computed from PO/GRN history once those land (Tasks 2.6/2.7).
 */
@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /suppliers — company-scoped, filtered, paginated (by name). */
  async list(
    query: SupplierListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<SupplierWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.SupplierWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q } },
              { contactPerson: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.supplier.count({ where }),
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /suppliers/{id}. */
  async get(id: string, user: AuthUser): Promise<SupplierWire> {
    void user;
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, deletedAt: null },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return toWire(supplier);
  }

  /** POST /suppliers — 409 on a duplicate name within the company. */
  async create(dto: CreateSupplierDto, user: AuthUser): Promise<SupplierWire> {
    try {
      const supplier = await this.prisma.supplier.create({
        data: {
          companyId: user.companyId, // also force-injected by the extension
          name: dto.name,
          contactPerson: dto.contact_person ?? null,
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          address: dto.address ?? null,
          defaultCurrency: (dto.default_currency ?? 'USD').toUpperCase(),
          leadTimeDays: dto.lead_time_days ?? null,
          paymentTerms: dto.payment_terms ?? null,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return toWire(supplier);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }

  /** PATCH /suppliers/{id}. */
  async update(
    id: string,
    dto: UpdateSupplierDto,
    user: AuthUser,
  ): Promise<SupplierWire> {
    await this.get(id, user); // clean 404, tenancy-checked

    try {
      const supplier = await this.prisma.supplier.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.contact_person !== undefined
            ? { contactPerson: dto.contact_person }
            : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.default_currency !== undefined
            ? { defaultCurrency: dto.default_currency.toUpperCase() }
            : {}),
          ...(dto.lead_time_days !== undefined
            ? { leadTimeDays: dto.lead_time_days }
            : {}),
          ...(dto.payment_terms !== undefined
            ? { paymentTerms: dto.payment_terms }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return toWire(supplier);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }
}

/** Map a P2002 (unique name) to a clean 409; rethrow anything else. */
function mapUniqueViolation(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException('A supplier with this name already exists');
  }
  return e;
}

function toWire(s: Supplier): SupplierWire {
  return {
    id: s.id,
    name: s.name,
    contact_person: s.contactPerson,
    phone: s.phone,
    email: s.email,
    address: s.address,
    default_currency: s.defaultCurrency,
    lead_time_days: s.leadTimeDays,
    payment_terms: s.paymentTerms,
    active: s.active,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}
