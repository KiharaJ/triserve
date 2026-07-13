import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Device } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { normalizeImeiSerial } from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateDeviceDto,
  DeviceListQueryDto,
  UpdateDeviceDto,
} from './dto/device.dto';

/** Wire shape of one device (snake_case per API convention). */
export interface DeviceWire {
  id: string;
  customer_id: string;
  customer_name: string | null;
  brand: string;
  model: string | null;
  model_id: string | null;
  category: string;
  device_type: string | null;
  imei_serial: string | null;
  color: string | null;
  created_at: string;
  updated_at: string;
}

type DeviceRow = Prisma.DeviceGetPayload<{
  include: { customer: { select: { name: true } } };
}>;
const WITH_CUSTOMER = {
  customer: { select: { name: true } },
} as const;

const DEFAULT_PAGE_SIZE = 20;

/**
 * Devices (Task 1.1, DESIGN.md §4.2 / E3). COMPANY-scoped, NOT
 * branch-scoped — a device follows its customer, who can be served at any
 * branch (see company-scope.extension.ts). imei_serial is stored CLEANED
 * (normalizeImeiSerial: scientific-notation legacy values expanded,
 * separators stripped, uppercased) and indexed — but deliberately NOT
 * unique: ownership changes and re-registrations must not collide (E3).
 * Mutations audited automatically (Device ∈ AUDITED_MODELS).
 */
@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /devices — paginated; `imei` matches normalized imei_serial. */
  async list(
    query: DeviceListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<DeviceWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const imei = normalizeImeiSerial(query.imei);
    const cleanedQ = query.q ? normalizeImeiSerial(query.q) : null;

    // companyId set explicitly AND re-tightened by the scope extension.
    const where: Prisma.DeviceWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.customer_id ? { customerId: query.customer_id } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.type ? { deviceType: query.type } : {}),
      ...(imei ? { imeiSerial: { contains: imei } } : {}),
      ...(query.q
        ? {
            OR: [
              { brand: { contains: query.q } },
              { model: { contains: query.q } },
              { deviceType: { contains: query.q } },
              { customer: { name: { contains: query.q } } },
              ...(cleanedQ ? [{ imeiSerial: { contains: cleanedQ } }] : []),
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.device.count({ where }),
      this.prisma.device.findMany({
        where,
        include: WITH_CUSTOMER,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /customers/{id}/devices — that customer's devices, scoped. */
  async listForCustomer(
    customerId: string,
    user: AuthUser,
  ): Promise<PaginatedResponse<DeviceWire>> {
    return this.list({ customer_id: customerId }, user);
  }

  /** GET /devices/{id}. */
  async get(id: string): Promise<DeviceWire> {
    const device = await this.prisma.device.findFirst({
      where: { id, deletedAt: null },
      include: WITH_CUSTOMER,
    });
    if (!device) throw new NotFoundException('Device not found');
    return toWire(device);
  }

  /** POST /devices — plain create (find-or-create arrives with jobs, 1.3). */
  async create(dto: CreateDeviceDto, user: AuthUser): Promise<DeviceWire> {
    await this.assertCustomerInCompany(dto.customer_id);
    await this.assertModelInCompany(dto.model_id);

    const device = await this.prisma.device.create({
      data: {
        companyId: user.companyId, // also force-injected by the extension
        customerId: dto.customer_id,
        brand: dto.brand ?? 'Samsung',
        model: dto.model ?? null,
        modelId: dto.model_id ?? null,
        category: dto.category ?? 'OTHER',
        deviceType: dto.device_type ?? null,
        imeiSerial: normalizeImeiSerial(dto.imei_serial),
        color: dto.color ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
      include: WITH_CUSTOMER,
    });
    return toWire(device);
  }

  /** PATCH /devices/{id}. */
  async update(
    id: string,
    dto: UpdateDeviceDto,
    user: AuthUser,
  ): Promise<DeviceWire> {
    await this.get(id); // clean 404 (scope extension pins the read)
    if (dto.customer_id !== undefined) {
      await this.assertCustomerInCompany(dto.customer_id);
    }
    await this.assertModelInCompany(dto.model_id);

    const device = await this.prisma.device.update({
      where: { id },
      data: {
        ...(dto.customer_id !== undefined
          ? { customerId: dto.customer_id }
          : {}),
        ...(dto.brand !== undefined ? { brand: dto.brand } : {}),
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.model_id !== undefined ? { modelId: dto.model_id } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.device_type !== undefined ? { deviceType: dto.device_type } : {}),
        ...(dto.imei_serial !== undefined
          ? { imeiSerial: normalizeImeiSerial(dto.imei_serial) }
          : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
        updatedById: user.userId,
      },
      include: WITH_CUSTOMER,
    });
    return toWire(device);
  }

  /**
   * customer_id must resolve WITHIN the caller's company — the scope
   * extension pins the read, so a foreign customer id simply doesn't exist.
   */
  private async assertCustomerInCompany(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
    });
    if (!customer) {
      throw new BadRequestException(
        'customer_id does not match a customer of your company',
      );
    }
  }

  private async assertModelInCompany(modelId?: string): Promise<void> {
    if (!modelId) return;
    const model = await this.prisma.deviceModel.findFirst({
      where: { id: modelId, deletedAt: null },
    });
    if (!model) {
      throw new BadRequestException(
        'model_id does not match a model of your company',
      );
    }
  }
}

function toWire(d: DeviceRow): DeviceWire {
  return {
    id: d.id,
    customer_id: d.customerId,
    customer_name: d.customer?.name ?? null,
    brand: d.brand,
    model: d.model,
    model_id: d.modelId,
    category: d.category,
    device_type: d.deviceType,
    imei_serial: d.imeiSerial,
    color: d.color,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}
