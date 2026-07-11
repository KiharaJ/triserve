import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { InventoryService } from '../inventory/inventory.service';
import type { GrnListQueryDto, ReceiveGoodsDto } from './dto/grn.dto';

const DEFAULT_PAGE_SIZE = 20;

export interface GrnLineWire {
  id: string;
  po_line_id: string;
  part_id: string;
  part: { part_number: string; description: string };
  qty_received: number;
  qty_rejected: number;
  unit_cost: string;
  bin_location: string | null;
}

export interface GrnWire {
  id: string;
  grn_no: string;
  po_id: string;
  po_no: string;
  branch_id: string;
  branch_code: string;
  received_date: string;
  received_by: string;
  supplier_delivery_ref: string | null;
  notes: string | null;
  created_at: string;
  lines: GrnLineWire[];
}

type GrnFull = Prisma.GoodsReceivedNoteGetPayload<{
  include: {
    po: true;
    branch: true;
    lines: { include: { part: true } };
  };
}>;

const FULL_INCLUDE = {
  po: true,
  branch: true,
  lines: { include: { part: true } },
} as const;

/**
 * Goods received notes (Task 2.7, DESIGN.md §4.4b) — receiving against a PO.
 *
 * Posting a GRN is what actually MOVES stock: each received line writes a
 * RECEIPT through InventoryService.applyMovement (ref_type GRN), bumps the PO
 * line's qty_received, and — when every line is fully received — flips the PO
 * to RECEIVED (else PARTIALLY_RECEIVED). Header + lines + stock movements + PO
 * updates all commit in ONE transaction. Company- AND branch-scoped (the GRN
 * lands at the PO's branch). qty_rejected is recorded but does not move stock.
 */
@Injectable()
export class GrnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
  ) {}

  /** GET /goods-received-notes — company/branch scoped, filtered, paginated. */
  async list(
    query: GrnListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<GrnWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.GoodsReceivedNoteWhereInput = {
      companyId: user.companyId,
      ...(query.po_id ? { poId: query.po_id } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.q ? { grnNo: { contains: query.q } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.goodsReceivedNote.count({ where }),
      this.prisma.goodsReceivedNote.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /goods-received-notes/{id}. */
  async get(id: string, user: AuthUser): Promise<GrnWire> {
    void user; // scoping applied by the Prisma extension
    const grn = await this.prisma.goodsReceivedNote.findFirst({
      where: { id },
      include: FULL_INCLUDE,
    });
    if (!grn) throw new NotFoundException('Goods received note not found');
    return toWire(grn);
  }

  /**
   * POST /purchase-orders/{poId}/receipts — post a GRN, moving stock.
   * The PO must be ORDERED or PARTIALLY_RECEIVED; each line receives at most
   * its outstanding quantity, and at least one line must receive stock.
   */
  async receive(
    poId: string,
    dto: ReceiveGoodsDto,
    user: AuthUser,
  ): Promise<GrnWire> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: poId, deletedAt: null },
      include: { lines: true },
    });
    if (!po) throw new NotFoundException('Purchase order not found');
    if (po.status !== 'ORDERED' && po.status !== 'PARTIALLY_RECEIVED') {
      throw new UnprocessableEntityException(
        'Only an ORDERED purchase order can be received against',
      );
    }

    const lineById = new Map(po.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    let totalReceived = 0;
    for (const l of dto.lines) {
      if (seen.has(l.po_line_id)) {
        throw new BadRequestException('A PO line appears more than once');
      }
      seen.add(l.po_line_id);
      const poLine = lineById.get(l.po_line_id);
      if (!poLine) {
        throw new BadRequestException(
          'po_line_id does not belong to this purchase order',
        );
      }
      const outstanding = poLine.qtyOrdered - poLine.qtyReceived;
      if (l.qty_received > outstanding) {
        throw new UnprocessableEntityException(
          `Received quantity exceeds the outstanding ${outstanding} for a line`,
        );
      }
      totalReceived += l.qty_received;
    }
    if (totalReceived <= 0) {
      throw new UnprocessableEntityException(
        'A GRN must receive stock on at least one line',
      );
    }

    const grnNo = await this.generateGrnNo(
      user.companyId,
      po.branchId,
      await this.branchCode(po.branchId),
      new Date().getFullYear(),
    );
    const receivedDate = dto.received_date
      ? new Date(dto.received_date)
      : new Date();

    const grn = await this.prisma.$transaction(async (tx) => {
      const created = await tx.goodsReceivedNote.create({
        data: {
          companyId: user.companyId,
          grnNo,
          poId: po.id,
          branchId: po.branchId,
          receivedDate,
          receivedById: user.userId,
          supplierDeliveryRef: dto.supplier_delivery_ref ?? null,
          notes: dto.notes ?? null,
          lines: {
            create: dto.lines.map((l) => {
              const poLine = lineById.get(l.po_line_id)!;
              return {
                poLineId: l.po_line_id,
                partId: poLine.partId,
                qtyReceived: l.qty_received,
                qtyRejected: l.qty_rejected ?? 0,
                unitCost:
                  l.unit_cost !== undefined
                    ? BigInt(l.unit_cost)
                    : poLine.unitCost,
                binLocation: l.bin_location ?? null,
              };
            }),
          },
        },
      });

      for (const l of dto.lines) {
        if (l.qty_received <= 0) continue;
        const poLine = lineById.get(l.po_line_id)!;
        const unitCost =
          l.unit_cost !== undefined ? BigInt(l.unit_cost) : poLine.unitCost;

        await this.inventory.applyMovement(
          {
            companyId: user.companyId,
            branchId: po.branchId,
            partId: poLine.partId,
            type: 'RECEIPT',
            qty: l.qty_received,
            refType: 'GRN',
            refId: created.id,
            unitCost,
            costCurrency: po.currency,
            reason: `GRN ${grnNo} for PO ${po.poNo}`,
            movedById: user.userId,
          },
          tx,
        );

        if (l.bin_location) {
          await tx.$executeRaw`
            UPDATE inventory SET bin_location = ${l.bin_location},
              updated_by = ${user.userId}, updated_at = NOW(3)
            WHERE branch_id = ${po.branchId} AND part_id = ${poLine.partId}`;
        }

        const newReceived = poLine.qtyReceived + l.qty_received;
        await tx.purchaseOrderLine.update({
          where: { id: poLine.id },
          data: {
            qtyReceived: newReceived,
            lineStatus:
              newReceived >= poLine.qtyOrdered ? 'RECEIVED' : 'PARTIAL',
          },
        });
      }

      // Recompute the PO status from the fresh line totals.
      const lines = await tx.purchaseOrderLine.findMany({
        where: { poId: po.id },
      });
      const fullyReceived = lines.every(
        (l) => l.lineStatus === 'CANCELLED' || l.qtyReceived >= l.qtyOrdered,
      );
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: {
          status: fullyReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          updatedById: user.userId,
        },
      });

      return created;
    });

    await this.audit.record({
      entityType: 'GoodsReceivedNote',
      entityId: grn.id,
      action: 'CREATE',
      after: { grn_no: grnNo, po_no: po.poNo, total_received: totalReceived },
      companyId: user.companyId,
      branchId: po.branchId,
      actorUserId: user.userId,
    });

    return this.get(grn.id, user);
  }

  // ------------------------------------------------------------------ helpers

  private async branchCode(branchId: string): Promise<string> {
    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { id: branchId },
      select: { code: true },
    });
    return branch.code;
  }

  private async generateGrnNo(
    companyId: string,
    branchId: string,
    branchCode: string,
    year: number,
  ): Promise<string> {
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO grn_counters (id, company_id, branch_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${branchId}, ${year}, LAST_INSERT_ID(1), NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1), updated_at = NOW(3)`;
      const rows = await tx.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });
    return `GRN-${branchCode}-${year}-${String(seq).padStart(4, '0')}`;
  }
}

function toWire(grn: GrnFull): GrnWire {
  return {
    id: grn.id,
    grn_no: grn.grnNo,
    po_id: grn.poId,
    po_no: grn.po.poNo,
    branch_id: grn.branchId,
    branch_code: grn.branch.code,
    received_date: grn.receivedDate.toISOString(),
    received_by: grn.receivedById,
    supplier_delivery_ref: grn.supplierDeliveryRef,
    notes: grn.notes,
    created_at: grn.createdAt.toISOString(),
    lines: grn.lines.map((l) => ({
      id: l.id,
      po_line_id: l.poLineId,
      part_id: l.partId,
      part: {
        part_number: l.part.partNumber,
        description: l.part.description,
      },
      qty_received: l.qtyReceived,
      qty_rejected: l.qtyRejected,
      unit_cost: l.unitCost.toString(),
      bin_location: l.binLocation,
    })),
  };
}
