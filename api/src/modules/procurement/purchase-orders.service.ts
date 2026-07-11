import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type PurchaseOrderStatus } from '@prisma/client';
import { roleHasPermission, type PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreatePurchaseOrderDto,
  PoLineInput,
  PurchaseOrderListQueryDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';

const DEFAULT_PAGE_SIZE = 20;

export interface PoLineWire {
  id: string;
  part_id: string;
  part: { part_number: string; description: string };
  qty_ordered: number;
  qty_received: number;
  unit_cost: string;
  currency: string;
  line_status: string;
}

export interface PurchaseOrderWire {
  id: string;
  po_no: string;
  supplier_id: string;
  supplier_name: string;
  branch_id: string;
  branch_code: string;
  status: PurchaseOrderStatus;
  currency: string;
  order_date: string | null;
  expected_date: string | null;
  subtotal: string;
  tax: string;
  shipping: string;
  total: string;
  requires_approval: boolean;
  approved_by: string | null;
  ordered_at: string | null;
  notes: string | null;
  created_at: string;
  lines: PoLineWire[];
}

type PoFull = Prisma.PurchaseOrderGetPayload<{
  include: {
    supplier: true;
    branch: true;
    lines: { include: { part: true } };
  };
}>;

const FULL_INCLUDE = {
  supplier: true,
  branch: true,
  lines: { include: { part: true } },
} as const;

/**
 * Purchase orders (Task 2.6, DESIGN.md §4.4b).
 *
 * DRAFT → SUBMITTED → (APPROVED) → ORDERED → …received (Task 2.7). Submitting
 * computes whether the order needs manager sign-off (total ≥ the PURCHASE_ORDER
 * threshold, §4.11) and records it on the PO; a PO that requires approval can't
 * be ORDERED until a po.approve holder APPROVES it. Approval is PO-native (a
 * SUBMITTED→APPROVED transition gated by po.approve), not a generic Approval
 * row — the SUBMITTED PO itself is the pending-approval signal in the list.
 * Company- AND branch-scoped (branch_id = destination). Lifecycle transitions
 * emit semantic AuditService rows.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(
    query: PurchaseOrderListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<PurchaseOrderWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.PurchaseOrderWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplier_id ? { supplierId: query.supplier_id } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.q ? { poNo: { contains: query.q } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.purchaseOrder.count({ where }),
      this.prisma.purchaseOrder.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  async get(id: string, user: AuthUser): Promise<PurchaseOrderWire> {
    void user; // scoping is applied by the Prisma extension in load()
    return toWire(await this.load(id));
  }

  // ---------------------------------------------------------------- mutations

  /** POST /purchase-orders — draft an order (no stock effect). */
  async create(
    dto: CreatePurchaseOrderDto,
    user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    const branchId = dto.branch_id ?? user.homeBranchId;
    if (!branchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);

    const supplier = await this.resolveSupplier(dto.supplier_id);
    await this.assertPartsInCompany(dto.lines);

    const subtotal = lineSubtotal(dto.lines);
    const tax = BigInt(dto.tax ?? '0');
    const shipping = BigInt(dto.shipping ?? '0');
    const poNo = await this.generatePoNo(
      user.companyId,
      branchId,
      await this.branchCode(branchId),
      new Date().getFullYear(),
    );

    const po = await this.prisma.purchaseOrder.create({
      data: {
        companyId: user.companyId,
        poNo,
        supplierId: supplier.id,
        branchId,
        status: 'DRAFT',
        currency: supplier.defaultCurrency,
        expectedDate: dto.expected_date ? new Date(dto.expected_date) : null,
        subtotal,
        tax,
        shipping,
        total: subtotal + tax + shipping,
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
        lines: {
          create: dto.lines.map((l) => ({
            partId: l.part_id,
            qtyOrdered: l.qty_ordered,
            unitCost: BigInt(l.unit_cost),
            currency: supplier.defaultCurrency,
          })),
        },
      },
      include: FULL_INCLUDE,
    });
    return toWire(po);
  }

  /** PATCH /purchase-orders/{id} — DRAFT only; lines (if given) replace all. */
  async update(
    id: string,
    dto: UpdatePurchaseOrderDto,
    user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    const po = await this.load(id);
    if (po.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT purchase order can be edited');
    }

    let currency = po.currency;
    if (dto.supplier_id && dto.supplier_id !== po.supplierId) {
      currency = (await this.resolveSupplier(dto.supplier_id)).defaultCurrency;
    }
    if (dto.lines) await this.assertPartsInCompany(dto.lines);

    const subtotal = dto.lines ? lineSubtotal(dto.lines) : po.subtotal;
    const tax = dto.tax !== undefined ? BigInt(dto.tax) : po.tax;
    const shipping =
      dto.shipping !== undefined ? BigInt(dto.shipping) : po.shipping;

    await this.prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        ...(dto.supplier_id ? { supplierId: dto.supplier_id, currency } : {}),
        ...(dto.expected_date !== undefined
          ? {
              expectedDate: dto.expected_date
                ? new Date(dto.expected_date)
                : null,
            }
          : {}),
        ...(dto.tax !== undefined ? { tax } : {}),
        ...(dto.shipping !== undefined ? { shipping } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        subtotal,
        total: subtotal + tax + shipping,
        updatedById: user.userId,
        ...(dto.lines
          ? {
              lines: {
                deleteMany: {},
                create: dto.lines.map((l) => ({
                  partId: l.part_id,
                  qtyOrdered: l.qty_ordered,
                  unitCost: BigInt(l.unit_cost),
                  currency,
                })),
              },
            }
          : {}),
      },
    });
    return this.get(id, user);
  }

  /**
   * POST /purchase-orders/{id}/submit — DRAFT → SUBMITTED, recording whether
   * the order needs manager approval (total ≥ the PURCHASE_ORDER threshold).
   */
  async submit(id: string, user: AuthUser): Promise<PurchaseOrderWire> {
    const po = await this.load(id);
    if (po.status !== 'DRAFT') {
      throw new ConflictException(
        'Only a DRAFT purchase order can be submitted',
      );
    }
    const { required } = await this.approvals.isRequired(
      'PURCHASE_ORDER',
      { amount: po.total },
      user.companyId,
    );
    await this.prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: 'SUBMITTED',
        requiresApproval: required,
        updatedById: user.userId,
      },
    });
    await this.recordTransition(po, 'SUBMITTED', user, {
      requires_approval: required,
    });
    return this.get(id, user);
  }

  /** POST /purchase-orders/{id}/approve — SUBMITTED → APPROVED (po.approve). */
  async approve(id: string, user: AuthUser): Promise<PurchaseOrderWire> {
    if (!roleHasPermission(user.role, 'po.approve')) {
      throw new ForbiddenException('Missing permission(s): po.approve');
    }
    const po = await this.load(id);
    if (po.status !== 'SUBMITTED') {
      throw new ConflictException(
        'Only a SUBMITTED purchase order can be approved',
      );
    }
    await this.prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: 'APPROVED',
        approvedById: user.userId,
        updatedById: user.userId,
      },
    });
    await this.recordTransition(po, 'APPROVED', user, {});
    return this.get(id, user);
  }

  /**
   * POST /purchase-orders/{id}/order — SUBMITTED/APPROVED → ORDERED. Blocked
   * when the PO requires approval and is not yet APPROVED. Stamps order_date
   * and, if unset, expected_date = today + the supplier's lead time.
   */
  async order(id: string, user: AuthUser): Promise<PurchaseOrderWire> {
    const po = await this.load(id);
    if (po.status !== 'SUBMITTED' && po.status !== 'APPROVED') {
      throw new ConflictException(
        'Only a SUBMITTED or APPROVED purchase order can be ordered',
      );
    }
    if (po.requiresApproval && po.status !== 'APPROVED') {
      throw new UnprocessableEntityException(
        'This order requires approval before it can be ordered',
      );
    }
    const now = new Date();
    const expected =
      po.expectedDate ??
      (po.supplier.leadTimeDays != null
        ? new Date(now.getTime() + po.supplier.leadTimeDays * 86_400_000)
        : null);

    await this.prisma.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: 'ORDERED',
        orderDate: now,
        orderedAt: now,
        expectedDate: expected,
        updatedById: user.userId,
      },
    });
    await this.recordTransition(po, 'ORDERED', user, {});
    return this.get(id, user);
  }

  /** POST /purchase-orders/{id}/cancel — before any stock is received. */
  async cancel(id: string, user: AuthUser): Promise<PurchaseOrderWire> {
    const po = await this.load(id);
    if (po.status === 'RECEIVED' || po.status === 'CANCELLED') {
      throw new ConflictException(
        `Cannot cancel a ${po.status} purchase order`,
      );
    }
    if (po.lines.some((l) => l.qtyReceived > 0)) {
      throw new ConflictException(
        'Cannot cancel a purchase order that has received stock',
      );
    }
    await this.prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: 'CANCELLED', updatedById: user.userId },
    });
    await this.recordTransition(po, 'CANCELLED', user, {});
    return this.get(id, user);
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Load a PO of the acting tenant. Company AND branch scoping are applied
   * automatically by the Prisma extension (PurchaseOrder is branch-scoped), so
   * a scope='branch' user only ever loads their own branch's orders.
   */
  private async load(id: string): Promise<PoFull> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    return po;
  }

  private async recordTransition(
    po: PoFull,
    to: PurchaseOrderStatus,
    user: AuthUser,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record({
      entityType: 'PurchaseOrder',
      entityId: po.id,
      action: 'TRANSITION',
      before: { status: po.status },
      after: { status: to, ...extra },
      companyId: po.companyId,
      branchId: po.branchId,
      actorUserId: user.userId,
    });
  }

  private async resolveSupplier(supplierId: string): Promise<{
    id: string;
    defaultCurrency: string;
    leadTimeDays: number | null;
  }> {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, deletedAt: null, active: true },
      select: { id: true, defaultCurrency: true, leadTimeDays: true },
    });
    if (!supplier) {
      throw new BadRequestException(
        'supplier_id does not match an active supplier of your company',
      );
    }
    return supplier;
  }

  private async assertPartsInCompany(lines: PoLineInput[]): Promise<void> {
    const partIds = [...new Set(lines.map((l) => l.part_id))];
    const found = await this.prisma.part.findMany({
      where: { id: { in: partIds }, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== partIds.length) {
      throw new BadRequestException(
        'One or more part_id does not match a part of your company',
      );
    }
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

  private async branchCode(branchId: string): Promise<string> {
    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { id: branchId },
      select: { code: true },
    });
    return branch.code;
  }

  private async generatePoNo(
    companyId: string,
    branchId: string,
    branchCode: string,
    year: number,
  ): Promise<string> {
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO purchase_order_counters (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1), NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1), updated_at = NOW(3)`;
      const rows = await tx.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });
    return `PO-${branchCode}-${year}-${String(seq).padStart(4, '0')}`;
  }
}

/** Σ qty × unit_cost across the lines (minor units). */
function lineSubtotal(lines: PoLineInput[]): bigint {
  return lines.reduce(
    (sum, l) => sum + BigInt(l.qty_ordered) * BigInt(l.unit_cost),
    0n,
  );
}

function toWire(po: PoFull): PurchaseOrderWire {
  return {
    id: po.id,
    po_no: po.poNo,
    supplier_id: po.supplierId,
    supplier_name: po.supplier.name,
    branch_id: po.branchId,
    branch_code: po.branch.code,
    status: po.status,
    currency: po.currency,
    order_date: po.orderDate?.toISOString() ?? null,
    expected_date: po.expectedDate?.toISOString() ?? null,
    subtotal: po.subtotal.toString(),
    tax: po.tax.toString(),
    shipping: po.shipping.toString(),
    total: po.total.toString(),
    requires_approval: po.requiresApproval,
    approved_by: po.approvedById,
    ordered_at: po.orderedAt?.toISOString() ?? null,
    notes: po.notes,
    created_at: po.createdAt.toISOString(),
    lines: po.lines.map((l) => ({
      id: l.id,
      part_id: l.partId,
      part: {
        part_number: l.part.partNumber,
        description: l.part.description,
      },
      qty_ordered: l.qtyOrdered,
      qty_received: l.qtyReceived,
      unit_cost: l.unitCost.toString(),
      currency: l.currency,
      line_status: l.lineStatus,
    })),
  };
}
