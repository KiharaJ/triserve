import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type DeviceCategory } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreatePartDto,
  PartListQueryDto,
  UpdatePartDto,
} from './dto/part.dto';

/** Wire shape of one part (snake_case; money as minor-unit strings). */
export interface PartWire {
  id: string;
  part_number: string;
  description: string;
  category: DeviceCategory;
  unit_cost_usd: string | null;
  default_sell_price_tzs: string | null;
  compatible_models: string[];
  is_serialized: boolean;
  preferred_supplier_id: string | null;
  /** Resolved preferred supplier (Task 2.5) — null when unset. */
  preferred_supplier: { id: string; name: string } | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

type PartWithSupplier = Prisma.PartGetPayload<{
  include: { preferredSupplier: true };
}>;

const DEFAULT_PAGE_SIZE = 20;

/**
 * Parts catalogue (Task 2.1, DESIGN.md §4.4). One row per part number per
 * company — company-level config like `models`, NOT branch-scoped. Stock
 * levels live in `inventory` (see InventoryService); this is the reference
 * data (part number, description, cost, reorder/serial flags) they hang off.
 */
@Injectable()
export class PartsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /parts — company-scoped, filtered, paginated (by part number). */
  async list(
    query: PartListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<PartWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.PartWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.category ? { category: query.category } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { partNumber: { contains: query.q } },
              { description: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.part.count({ where }),
      this.prisma.part.findMany({
        where,
        include: { preferredSupplier: true },
        orderBy: [{ partNumber: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /parts/{id}. */
  async get(id: string, user: AuthUser): Promise<PartWire> {
    void user;
    const part = await this.prisma.part.findFirst({
      where: { id, deletedAt: null },
      include: { preferredSupplier: true },
    });
    if (!part) throw new NotFoundException('Part not found');
    return toWire(part);
  }

  /** POST /parts — 409 on a duplicate part number within the company. */
  async create(dto: CreatePartDto, user: AuthUser): Promise<PartWire> {
    if (dto.preferred_supplier_id) {
      await this.assertSupplierInCompany(dto.preferred_supplier_id);
    }
    try {
      const part = await this.prisma.part.create({
        data: {
          companyId: user.companyId, // also force-injected by the extension
          partNumber: dto.part_number,
          description: dto.description,
          category: dto.category,
          unitCostUsd: toBigIntOrNull(dto.unit_cost_usd),
          sellPriceTzs: toBigIntOrNull(dto.default_sell_price_tzs),
          compatibleModels: (dto.compatible_models ??
            undefined) as Prisma.InputJsonValue,
          isSerialized: dto.is_serialized ?? false,
          preferredSupplierId: dto.preferred_supplier_id ?? null,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
        include: { preferredSupplier: true },
      });
      return toWire(part);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }

  /** PATCH /parts/{id} — every field optional; `null` clears nullable money. */
  async update(
    id: string,
    dto: UpdatePartDto,
    user: AuthUser,
  ): Promise<PartWire> {
    await this.get(id, user); // clean 404, tenancy-checked
    if (dto.preferred_supplier_id) {
      await this.assertSupplierInCompany(dto.preferred_supplier_id);
    }

    try {
      const part = await this.prisma.part.update({
        where: { id },
        include: { preferredSupplier: true },
        data: {
          ...(dto.part_number !== undefined
            ? { partNumber: dto.part_number }
            : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.unit_cost_usd !== undefined
            ? { unitCostUsd: toBigIntOrNull(dto.unit_cost_usd) }
            : {}),
          ...(dto.default_sell_price_tzs !== undefined
            ? { sellPriceTzs: toBigIntOrNull(dto.default_sell_price_tzs) }
            : {}),
          ...(dto.compatible_models !== undefined
            ? {
                compatibleModels: dto.compatible_models,
              }
            : {}),
          ...(dto.is_serialized !== undefined
            ? { isSerialized: dto.is_serialized }
            : {}),
          ...(dto.preferred_supplier_id !== undefined
            ? { preferredSupplierId: dto.preferred_supplier_id }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return toWire(part);
    } catch (e) {
      throw mapUniqueViolation(e);
    }
  }

  /** 400 if preferred_supplier_id is not an active supplier of the company. */
  private async assertSupplierInCompany(supplierId: string): Promise<void> {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, deletedAt: null },
    });
    if (!supplier) {
      throw new BadRequestException(
        'preferred_supplier_id does not match a supplier of your company',
      );
    }
  }
}

function toBigIntOrNull(v: string | null | undefined): bigint | null {
  return v === undefined || v === null ? null : BigInt(v);
}

/** Map a P2002 (unique part_number) to a clean 409; rethrow anything else. */
function mapUniqueViolation(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException('A part with this part number already exists');
  }
  return e;
}

function toWire(p: PartWithSupplier): PartWire {
  return {
    id: p.id,
    part_number: p.partNumber,
    description: p.description,
    category: p.category,
    unit_cost_usd: p.unitCostUsd?.toString() ?? null,
    default_sell_price_tzs: p.sellPriceTzs?.toString() ?? null,
    compatible_models: Array.isArray(p.compatibleModels)
      ? (p.compatibleModels as string[])
      : [],
    is_serialized: p.isSerialized,
    preferred_supplier_id: p.preferredSupplierId,
    preferred_supplier: p.preferredSupplier
      ? { id: p.preferredSupplier.id, name: p.preferredSupplier.name }
      : null,
    active: p.active,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
