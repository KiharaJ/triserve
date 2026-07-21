import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type Currency,
  type DeviceCategory,
  type FaultCode,
  type PaymentMethod,
  type RepairAction,
  type ServiceCode,
  type ServiceCodeKind,
  type TaxRate,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  ConfigListQueryDto,
  CreateCurrencyDto,
  CreateFaultCodeDto,
  CreatePaymentMethodDto,
  CreateRepairActionDto,
  CreateServiceCodeDto,
  CreateTaxRateDto,
  ServiceCodeListQueryDto,
  UpdateCurrencyDto,
  UpdateFaultCodeDto,
  UpdatePaymentMethodDto,
  UpdateRepairActionDto,
  UpdateServiceCodeDto,
  UpdateTaxRateDto,
} from './dto/config-tables.dto';

/**
 * Per-company config tables (Task 0.7, DESIGN.md §4.14 / E17): payment
 * methods, fault codes, repair actions, tax rates, currencies.
 *
 * All five models are company-scoped (Prisma scope extension) and audited
 * (AUDITED_MODELS). "Delete" is a SOFT delete (deleted_at stamped, row
 * hidden from lists) per the schema convention — history keeps resolving.
 * Money is BIGINT minor units, serialized as strings on the wire; tax
 * percents are Decimal, serialized as strings.
 */

export interface PaymentMethodWire {
  id: string;
  code: string;
  label: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type FaultCodeWire = PaymentMethodWire;

/** One GSPN diagnostic code (§4.7). `kind` is what disambiguates the table. */
export interface ServiceCodeWire extends PaymentMethodWire {
  kind: ServiceCodeKind;
  category: DeviceCategory | null;
  sort_order: number;
}

export interface RepairActionWire extends PaymentMethodWire {
  default_labour_price: string | null;
  default_currency: string | null;
}

export interface TaxRateWire extends PaymentMethodWire {
  percent: string;
}

export interface CurrencyWire {
  id: string;
  code: string;
  name: string;
  symbol: string;
  is_base: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 20;

/** Common list plumbing: page maths + where assembled by the caller. */
interface ListArgs {
  page: number;
  pageSize: number;
}

function pageArgs(query: ConfigListQueryDto): ListArgs {
  return {
    page: query.page ?? 1,
    pageSize: query.page_size ?? DEFAULT_PAGE_SIZE,
  };
}

/** P2002 on (company_id, code) → 409 with a human message. */
function mapUniqueCode(e: unknown, what: string): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException(`A ${what} with this code already exists`);
  }
  return e;
}

/**
 * Service codes are unique per (company, KIND, code), so the clash message
 * must name the kind — the same code legitimately exists under two kinds
 * (GSPN uses "03" for both a symptom and a defect).
 */
function mapUniqueServiceCode(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException(
      'A service code with this kind and code already exists',
    );
  }
  return e;
}

@Injectable()
export class ConfigTablesService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Payment methods
  // -------------------------------------------------------------------------

  async listPaymentMethods(
    query: ConfigListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<PaymentMethodWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.PaymentMethodWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { label: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.paymentMethod.count({ where }),
      this.prisma.paymentMethod.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(paymentMethodToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createPaymentMethod(
    dto: CreatePaymentMethodDto,
    user: AuthUser,
  ): Promise<PaymentMethodWire> {
    try {
      const row = await this.prisma.paymentMethod.create({
        data: {
          companyId: user.companyId,
          code: dto.code.toUpperCase(),
          label: dto.label,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return paymentMethodToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'payment method');
    }
  }

  async updatePaymentMethod(
    id: string,
    dto: UpdatePaymentMethodDto,
    user: AuthUser,
  ): Promise<PaymentMethodWire> {
    await this.mustExist(this.prisma.paymentMethod, id, 'Payment method');
    try {
      const row = await this.prisma.paymentMethod.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return paymentMethodToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'payment method');
    }
  }

  async removePaymentMethod(id: string, user: AuthUser): Promise<void> {
    await this.mustExist(this.prisma.paymentMethod, id, 'Payment method');
    await this.prisma.paymentMethod.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Fault codes
  // -------------------------------------------------------------------------

  async listFaultCodes(
    query: ConfigListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<FaultCodeWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.FaultCodeWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { label: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.faultCode.count({ where }),
      this.prisma.faultCode.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(faultCodeToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createFaultCode(
    dto: CreateFaultCodeDto,
    user: AuthUser,
  ): Promise<FaultCodeWire> {
    try {
      const row = await this.prisma.faultCode.create({
        data: {
          companyId: user.companyId,
          code: dto.code.toUpperCase(),
          label: dto.label,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return faultCodeToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'fault code');
    }
  }

  async updateFaultCode(
    id: string,
    dto: UpdateFaultCodeDto,
    user: AuthUser,
  ): Promise<FaultCodeWire> {
    await this.mustExist(this.prisma.faultCode, id, 'Fault code');
    try {
      const row = await this.prisma.faultCode.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return faultCodeToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'fault code');
    }
  }

  async removeFaultCode(id: string, user: AuthUser): Promise<void> {
    await this.mustExist(this.prisma.faultCode, id, 'Fault code');
    await this.prisma.faultCode.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Service codes (Samsung GSPN diagnostic vocabulary, §4.7)
  // -------------------------------------------------------------------------

  async listServiceCodes(
    query: ServiceCodeListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<ServiceCodeWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.ServiceCodeWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      // A code with category NULL applies to every device grouping, so a
      // category filter must INCLUDE the universal codes, not just the
      // grouping-specific ones.
      ...(query.category !== undefined
        ? { OR: [{ category: query.category }, { category: null }] }
        : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            AND: [
              {
                OR: [
                  { code: { contains: query.q } },
                  { label: { contains: query.q } },
                ],
              },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.serviceCode.count({ where }),
      this.prisma.serviceCode.findMany({
        where,
        // Grouped by kind so a mixed list stays readable, then by the
        // curator's ordering, then code as a stable tiebreak.
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(serviceCodeToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createServiceCode(
    dto: CreateServiceCodeDto,
    user: AuthUser,
  ): Promise<ServiceCodeWire> {
    try {
      const row = await this.prisma.serviceCode.create({
        data: {
          companyId: user.companyId,
          kind: dto.kind,
          // Samsung codes are case-significant as published (e.g. "T83", "Q",
          // "A01") — stored verbatim, unlike our own uppercased config codes.
          code: dto.code,
          label: dto.label,
          category: dto.category ?? null,
          sortOrder: dto.sort_order ?? 0,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return serviceCodeToWire(row);
    } catch (e) {
      throw mapUniqueServiceCode(e);
    }
  }

  async updateServiceCode(
    id: string,
    dto: UpdateServiceCodeDto,
    user: AuthUser,
  ): Promise<ServiceCodeWire> {
    await this.mustExist(this.prisma.serviceCode, id, 'Service code');
    try {
      const row = await this.prisma.serviceCode.update({
        where: { id },
        data: {
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.code !== undefined ? { code: dto.code } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.category !== undefined ? { category: dto.category } : {}),
          ...(dto.sort_order !== undefined
            ? { sortOrder: dto.sort_order }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return serviceCodeToWire(row);
    } catch (e) {
      throw mapUniqueServiceCode(e);
    }
  }

  async removeServiceCode(id: string, user: AuthUser): Promise<void> {
    await this.mustExist(this.prisma.serviceCode, id, 'Service code');
    await this.prisma.serviceCode.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Repair actions
  // -------------------------------------------------------------------------

  async listRepairActions(
    query: ConfigListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<RepairActionWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.RepairActionWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { label: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.repairAction.count({ where }),
      this.prisma.repairAction.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(repairActionToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createRepairAction(
    dto: CreateRepairActionDto,
    user: AuthUser,
  ): Promise<RepairActionWire> {
    try {
      const row = await this.prisma.repairAction.create({
        data: {
          companyId: user.companyId,
          code: dto.code.toUpperCase(),
          label: dto.label,
          defaultLabourPrice: dto.default_labour_price
            ? BigInt(dto.default_labour_price)
            : null,
          defaultCurrency: dto.default_currency?.toUpperCase() ?? null,
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return repairActionToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'repair action');
    }
  }

  async updateRepairAction(
    id: string,
    dto: UpdateRepairActionDto,
    user: AuthUser,
  ): Promise<RepairActionWire> {
    await this.mustExist(this.prisma.repairAction, id, 'Repair action');
    try {
      const row = await this.prisma.repairAction.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.default_labour_price !== undefined
            ? {
                defaultLabourPrice: dto.default_labour_price
                  ? BigInt(dto.default_labour_price)
                  : null,
              }
            : {}),
          ...(dto.default_currency !== undefined
            ? {
                defaultCurrency: dto.default_currency
                  ? dto.default_currency.toUpperCase()
                  : null,
              }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return repairActionToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'repair action');
    }
  }

  async removeRepairAction(id: string, user: AuthUser): Promise<void> {
    await this.mustExist(this.prisma.repairAction, id, 'Repair action');
    await this.prisma.repairAction.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Tax rates
  // -------------------------------------------------------------------------

  async listTaxRates(
    query: ConfigListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<TaxRateWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.TaxRateWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { label: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.taxRate.count({ where }),
      this.prisma.taxRate.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(taxRateToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createTaxRate(
    dto: CreateTaxRateDto,
    user: AuthUser,
  ): Promise<TaxRateWire> {
    try {
      const row = await this.prisma.taxRate.create({
        data: {
          companyId: user.companyId,
          code: dto.code.toUpperCase(),
          label: dto.label,
          percent: new Prisma.Decimal(dto.percent),
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return taxRateToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'tax rate');
    }
  }

  async updateTaxRate(
    id: string,
    dto: UpdateTaxRateDto,
    user: AuthUser,
  ): Promise<TaxRateWire> {
    await this.mustExist(this.prisma.taxRate, id, 'Tax rate');
    try {
      const row = await this.prisma.taxRate.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.percent !== undefined
            ? { percent: new Prisma.Decimal(dto.percent) }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return taxRateToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'tax rate');
    }
  }

  async removeTaxRate(id: string, user: AuthUser): Promise<void> {
    await this.mustExist(this.prisma.taxRate, id, 'Tax rate');
    await this.prisma.taxRate.update({
      where: { id },
      data: { deletedAt: new Date(), active: false, updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Currencies
  // -------------------------------------------------------------------------

  async listCurrencies(
    query: ConfigListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<CurrencyWire>> {
    const { page, pageSize } = pageArgs(query);
    const where: Prisma.CurrencyWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.q
        ? {
            OR: [
              { code: { contains: query.q } },
              { name: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.currency.count({ where }),
      this.prisma.currency.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      data: rows.map(currencyToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  async createCurrency(
    dto: CreateCurrencyDto,
    user: AuthUser,
  ): Promise<CurrencyWire> {
    try {
      const row = await this.prisma.currency.create({
        data: {
          companyId: user.companyId,
          code: dto.code.toUpperCase(),
          name: dto.name,
          symbol: dto.symbol,
          // is_base is managed via the company's base_currency, not here.
          isBase: false,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return currencyToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'currency');
    }
  }

  async updateCurrency(
    id: string,
    dto: UpdateCurrencyDto,
    user: AuthUser,
  ): Promise<CurrencyWire> {
    await this.mustExist(this.prisma.currency, id, 'Currency');
    try {
      const row = await this.prisma.currency.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.symbol !== undefined ? { symbol: dto.symbol } : {}),
          updatedById: user.userId,
        },
      });
      return currencyToWire(row);
    } catch (e) {
      throw mapUniqueCode(e, 'currency');
    }
  }

  async removeCurrency(id: string, user: AuthUser): Promise<void> {
    const row = await this.prisma.currency.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('Currency not found');
    if (row.isBase) {
      throw new BadRequestException('The base currency cannot be deleted');
    }
    await this.prisma.currency.update({
      where: { id },
      data: { deletedAt: new Date(), updatedById: user.userId },
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** 404 (not a Prisma P2025) when the row is missing/soft-deleted. */
  private async mustExist(
    delegate: {
      findFirst(args: {
        where: { id: string; deletedAt: null };
      }): Promise<unknown>;
    },
    id: string,
    what: string,
  ): Promise<void> {
    const row = await delegate.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new NotFoundException(`${what} not found`);
  }
}

function paymentMethodToWire(r: PaymentMethod): PaymentMethodWire {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function faultCodeToWire(r: FaultCode): FaultCodeWire {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function serviceCodeToWire(r: ServiceCode): ServiceCodeWire {
  return {
    id: r.id,
    kind: r.kind,
    code: r.code,
    label: r.label,
    category: r.category,
    sort_order: r.sortOrder,
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function repairActionToWire(r: RepairAction): RepairActionWire {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    default_labour_price: r.defaultLabourPrice?.toString() ?? null,
    default_currency: r.defaultCurrency,
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function taxRateToWire(r: TaxRate): TaxRateWire {
  return {
    id: r.id,
    code: r.code,
    label: r.label,
    percent: r.percent.toString(),
    active: r.active,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function currencyToWire(r: Currency): CurrencyWire {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    is_base: r.isBase,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}
