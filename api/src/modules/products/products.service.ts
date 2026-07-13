import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Product } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateProductDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './dto/product.dto';

const DEFAULT_PAGE_SIZE = 20;

/** Wire shape of a retail product (money as TZS/USD minor-unit strings). */
export interface ProductWire {
  id: string;
  sku: string;
  name: string;
  brand: string;
  device_type: string | null;
  category: string;
  sell_price_tzs: string | null;
  cost_usd: string | null;
  stock_qty: number;
  default_warranty_months: number | null;
  default_warranty_kind: string | null;
  is_serialized: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Products (retail catalogue) — the electronics the shop sells, any brand,
 * separate from the Samsung repair `parts`. Company-scoped master data; SKU is
 * unique per company. A PRODUCT_SALE invoice picks from here and can offer the
 * product's default warranty for registration.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ProductListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<ProductWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ProductWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.type ? { deviceType: query.type } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { sku: { contains: query.q } },
              { name: { contains: query.q } },
              { brand: { contains: query.q } },
              { deviceType: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string): Promise<ProductWire> {
    return toWire(await this.load(id));
  }

  async create(dto: CreateProductDto, user: AuthUser): Promise<ProductWire> {
    await this.assertSkuFree(user.companyId, dto.sku);
    const product = await this.prisma.product.create({
      data: {
        companyId: user.companyId,
        sku: dto.sku,
        name: dto.name,
        brand: dto.brand ?? '',
        deviceType: dto.device_type ?? null,
        category: dto.category ?? 'OTHER',
        sellPriceTzs: dto.sell_price_tzs ? BigInt(dto.sell_price_tzs) : null,
        costUsd: dto.cost_usd ? BigInt(dto.cost_usd) : null,
        stockQty: dto.stock_qty ?? 0,
        defaultWarrantyMonths: dto.default_warranty_months ?? null,
        defaultWarrantyKind: dto.default_warranty_kind ?? null,
        isSerialized: dto.is_serialized ?? false,
        createdById: user.userId,
        updatedById: user.userId,
      },
    });
    return toWire(product);
  }

  async update(
    id: string,
    dto: UpdateProductDto,
    user: AuthUser,
  ): Promise<ProductWire> {
    const product = await this.load(id);
    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.brand !== undefined ? { brand: dto.brand } : {}),
        ...(dto.device_type !== undefined ? { deviceType: dto.device_type } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.sell_price_tzs !== undefined
          ? { sellPriceTzs: dto.sell_price_tzs ? BigInt(dto.sell_price_tzs) : null }
          : {}),
        ...(dto.cost_usd !== undefined
          ? { costUsd: dto.cost_usd ? BigInt(dto.cost_usd) : null }
          : {}),
        ...(dto.stock_qty !== undefined ? { stockQty: dto.stock_qty } : {}),
        ...(dto.default_warranty_months !== undefined
          ? { defaultWarrantyMonths: dto.default_warranty_months }
          : {}),
        ...(dto.default_warranty_kind !== undefined
          ? { defaultWarrantyKind: dto.default_warranty_kind }
          : {}),
        ...(dto.is_serialized !== undefined ? { isSerialized: dto.is_serialized } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        updatedById: user.userId,
      },
    });
    return toWire(updated);
  }

  private async load(id: string): Promise<Product> {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  private async assertSkuFree(companyId: string, sku: string): Promise<void> {
    const existing = await this.prisma.product.findFirst({
      where: { companyId, sku, deletedAt: null },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`SKU ${sku} already exists`);
  }
}

function toWire(p: Product): ProductWire {
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    device_type: p.deviceType,
    category: p.category,
    sell_price_tzs: p.sellPriceTzs?.toString() ?? null,
    cost_usd: p.costUsd?.toString() ?? null,
    stock_qty: p.stockQty,
    default_warranty_months: p.defaultWarrantyMonths,
    default_warranty_kind: p.defaultWarrantyKind,
    is_serialized: p.isSerialized,
    active: p.active,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
