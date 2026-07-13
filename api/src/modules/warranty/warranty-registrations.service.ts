import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type WarrantyKind,
  type WarrantyRegistrationStatus,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { normalizeImeiSerial } from '../../common/util/phone';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateWarrantyRegistrationDto,
  UpdateWarrantyRegistrationDto,
  WarrantyRegistrationListQueryDto,
} from './dto/warranty-registration.dto';

const DEFAULT_PAGE_SIZE = 20;

export interface WarrantyRegistrationWire {
  id: string;
  branch_id: string;
  branch_code: string;
  customer_id: string | null;
  customer_name: string | null;
  device_id: string | null;
  invoice_id: string | null;
  invoice_no: string | null;
  product_name: string;
  brand: string;
  serial_no: string | null;
  kind: WarrantyKind;
  start_date: string;
  expiry_date: string;
  months: number | null;
  terms: string | null;
  /** Effective status: VOID as stored, else EXPIRED past expiry, else ACTIVE. */
  status: WarrantyRegistrationStatus;
  is_expired: boolean;
  notes: string | null;
  created_at: string;
}

type RegFull = Prisma.WarrantyRegistrationGetPayload<{
  include: { branch: true; customer: true; invoice: true };
}>;
const FULL_INCLUDE = { branch: true, customer: true, invoice: true } as const;

/**
 * Warranty registrations (retail) — a warranty issued when the shop SELLS an
 * electronic product (any brand). Distinct from Samsung IW claims: this records
 * coverage the customer holds, so a later repair can be identified as under
 * warranty. Keyed on serial for point-of-repair lookup. Company- AND
 * branch-scoped; extension-audited via AUDITED_MODELS is NOT used (semantic
 * AuditService rows here, mirroring the rest of the warranty module).
 */
@Injectable()
export class WarrantyRegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: WarrantyRegistrationListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<WarrantyRegistrationWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.WarrantyRegistrationWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status as WarrantyRegistrationStatus } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.customer_id ? { customerId: query.customer_id } : {}),
      ...(query.q
        ? {
            OR: [
              { productName: { contains: query.q } },
              { serialNo: { contains: query.q } },
              { brand: { contains: query.q } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.warrantyRegistration.count({ where }),
      this.prisma.warrantyRegistration.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string): Promise<WarrantyRegistrationWire> {
    return toWire(await this.load(id));
  }

  /**
   * GET /warranty-registrations/lookup?serial= — is this unit under warranty?
   * Returns the most recent non-VOID registration matching the serial, or null
   * (used at repair intake to decide who pays).
   */
  async lookup(
    serial: string,
    user: AuthUser,
  ): Promise<WarrantyRegistrationWire | null> {
    const norm = normalizeImeiSerial(serial);
    if (!norm) return null;
    const row = await this.prisma.warrantyRegistration.findFirst({
      where: {
        companyId: user.companyId,
        deletedAt: null,
        status: { not: 'VOID' },
        serialNo: norm,
      },
      include: FULL_INCLUDE,
      orderBy: [{ expiryDate: 'desc' }],
    });
    return row ? toWire(row) : null;
  }

  async create(
    dto: CreateWarrantyRegistrationDto,
    user: AuthUser,
  ): Promise<WarrantyRegistrationWire> {
    const branchId = dto.branch_id ?? user.homeBranchId;
    if (!branchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);
    if (dto.customer_id) await this.assertExists('customer', dto.customer_id);
    if (dto.device_id) await this.assertExists('device', dto.device_id);
    if (dto.invoice_id) await this.assertExists('invoice', dto.invoice_id);

    const start = new Date(dto.start_date);
    const expiry = dto.expiry_date
      ? new Date(dto.expiry_date)
      : dto.months
        ? addMonths(start, dto.months)
        : null;
    if (!expiry) {
      throw new BadRequestException('Provide expiry_date or months');
    }
    if (expiry < start) {
      throw new BadRequestException('expiry_date cannot precede start_date');
    }
    const serialNo = dto.serial_no
      ? normalizeImeiSerial(dto.serial_no)
      : null;

    const reg = await this.prisma.warrantyRegistration.create({
      data: {
        companyId: user.companyId,
        branchId,
        customerId: dto.customer_id ?? null,
        deviceId: dto.device_id ?? null,
        invoiceId: dto.invoice_id ?? null,
        productName: dto.product_name,
        brand: dto.brand ?? '',
        serialNo,
        kind: dto.kind,
        startDate: start,
        expiryDate: expiry,
        months: dto.months ?? null,
        terms: dto.terms ?? null,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
      },
      include: FULL_INCLUDE,
    });
    await this.recordAudit(reg, 'CREATE', user, {
      product: dto.product_name,
      kind: dto.kind,
    });
    return toWire(reg);
  }

  async update(
    id: string,
    dto: UpdateWarrantyRegistrationDto,
    user: AuthUser,
  ): Promise<WarrantyRegistrationWire> {
    const reg = await this.load(id);
    const updated = await this.prisma.warrantyRegistration.update({
      where: { id: reg.id },
      data: {
        ...(dto.product_name !== undefined ? { productName: dto.product_name } : {}),
        ...(dto.brand !== undefined ? { brand: dto.brand } : {}),
        ...(dto.expiry_date !== undefined
          ? { expiryDate: new Date(dto.expiry_date) }
          : {}),
        ...(dto.terms !== undefined ? { terms: dto.terms } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        updatedById: user.userId,
      },
      include: FULL_INCLUDE,
    });
    await this.recordAudit(updated, 'UPDATE', user, {
      ...(dto.status ? { status: dto.status } : {}),
    });
    return toWire(updated);
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<RegFull> {
    const reg = await this.prisma.warrantyRegistration.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!reg) throw new NotFoundException('Warranty registration not found');
    return reg;
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

  private async assertExists(
    kind: 'customer' | 'device' | 'invoice',
    id: string,
  ): Promise<void> {
    const found =
      kind === 'customer'
        ? await this.prisma.customer.findFirst({ where: { id, deletedAt: null } })
        : kind === 'device'
          ? await this.prisma.device.findFirst({ where: { id, deletedAt: null } })
          : await this.prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!found) {
      throw new BadRequestException(`${kind}_id does not match a ${kind} of your company`);
    }
  }

  private async recordAudit(
    reg: { id: string; companyId: string; branchId: string },
    action: 'CREATE' | 'UPDATE',
    user: AuthUser,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      entityType: 'WarrantyRegistration',
      entityId: reg.id,
      action,
      after,
      companyId: reg.companyId,
      branchId: reg.branchId,
      actorUserId: user.userId,
    });
  }
}

function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

/** Effective status: VOID stays VOID; else EXPIRED past expiry, else ACTIVE. */
function effectiveStatus(
  r: RegFull,
): { status: WarrantyRegistrationStatus; expired: boolean } {
  if (r.status === 'VOID') return { status: 'VOID', expired: false };
  const expired = r.expiryDate.getTime() < Date.now();
  return { status: expired ? 'EXPIRED' : 'ACTIVE', expired };
}

function toWire(r: RegFull): WarrantyRegistrationWire {
  const { status, expired } = effectiveStatus(r);
  return {
    id: r.id,
    branch_id: r.branchId,
    branch_code: r.branch.code,
    customer_id: r.customerId,
    customer_name: r.customer?.name ?? null,
    device_id: r.deviceId,
    invoice_id: r.invoiceId,
    invoice_no: r.invoice?.invoiceNo ?? null,
    product_name: r.productName,
    brand: r.brand,
    serial_no: r.serialNo,
    kind: r.kind,
    start_date: r.startDate.toISOString().slice(0, 10),
    expiry_date: r.expiryDate.toISOString().slice(0, 10),
    months: r.months,
    terms: r.terms,
    status,
    is_expired: expired,
    notes: r.notes,
    created_at: r.createdAt.toISOString(),
  };
}
