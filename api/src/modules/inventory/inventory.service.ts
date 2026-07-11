import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  Prisma,
  type DeviceCategory,
  type StockMovement,
  type StockMovementType,
  type StockRefType,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApprovalsService,
  type ApprovalEntry,
} from '../approvals/approvals.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  AdjustStockDto,
  InventoryListQueryDto,
  InventorySettingsDto,
  MovementListQueryDto,
  StockCountDto,
} from './dto/inventory.dto';

const DEFAULT_PAGE_SIZE = 20;

/** The four physical stock buckets of one inventory row (§4.4 / E10). */
export interface StockBuckets {
  onHand: number;
  reserved: number;
  inTransitIn: number;
  damaged: number;
}

/** Signed changes a single movement applies to the buckets. */
export type BucketDeltas = Partial<StockBuckets>;

/** Input to {@link InventoryService.applyMovement} — the one write path. */
export interface ApplyMovementInput {
  companyId: string;
  branchId: string;
  partId: string;
  type: StockMovementType;
  /** SIGNED ledger quantity (the sign convention per type — see below). */
  qty: number;
  refType?: StockRefType | null;
  refId?: string | null;
  unitCost?: bigint | null;
  costCurrency?: string | null;
  reason?: string | null;
  movedById: string;
}

/** Wire shape of one inventory row (snake_case; available derived). */
export interface InventoryWire {
  id: string;
  branch_id: string;
  part_id: string;
  part: { part_number: string; description: string; category: DeviceCategory };
  bin_location: string | null;
  qty_on_hand: number;
  qty_reserved: number;
  qty_in_transit_in: number;
  qty_damaged: number;
  /** Derived: on_hand − reserved − damaged (§4.4 / E10). */
  qty_available: number;
  reorder_level: number;
  low_stock: boolean;
  updated_at: string;
}

/** Wire shape of one stock movement (append-only ledger row). */
export interface StockMovementWire {
  id: string;
  branch_id: string;
  part_id: string;
  /** Part summary — present on ledger reads, null on adjust/count results. */
  part: { part_number: string; description: string } | null;
  movement_type: StockMovementType;
  qty: number;
  ref_type: StockRefType | null;
  ref_id: string | null;
  unit_cost: string | null;
  cost_currency: string | null;
  reason: string | null;
  moved_by: string;
  moved_at: string;
}

/** Result of a stock change — applied, or HELD pending approval (§4.11). */
export interface StockChangeResult {
  /** true when the change required approval: nothing moved, approval PENDING. */
  held: boolean;
  movement: StockMovementWire | null;
  inventory: InventoryWire;
  pending_approval?: ApprovalEntry;
}

/**
 * PURE bucket algebra (unit-testable without a DB): the signed changes a
 * movement of `qty` (already signed per the ledger convention) applies to the
 * stock buckets. Available stock is on_hand − reserved − damaged (§4.4 / E10).
 *
 * Sign convention (the SIGNED ledger qty):
 *   RECEIPT / RETURN                       qty > 0  → +on_hand
 *   CONSUMPTION / SALE / SUPPLIER_RETURN /
 *   TRANSFER_OUT                           qty < 0  → −on_hand
 *   TRANSFER_IN                            qty > 0  → +on_hand
 *   ADJUSTMENT                             either   → ±on_hand
 *   RESERVE                                qty > 0  → +reserved
 *   UNRESERVE                              qty < 0  → −reserved
 *   DAMAGE                                 qty > 0  → +damaged
 *
 * NOTE: `qty_in_transit_in` is DELIBERATELY not touched by any movement — it is
 * a transient tracker maintained by the transfer flow (Task 2.3) via
 * {@link InventoryService.bumpInTransit}, not derived from the ledger. Only the
 * three buckets that feed available stock (on_hand/reserved/damaged) are
 * movement-derived, so reconcile() can rebuild them from the ledger alone.
 */
export function movementBucketDeltas(
  type: StockMovementType,
  qty: number,
): BucketDeltas {
  switch (type) {
    case 'RECEIPT':
    case 'RETURN':
    case 'CONSUMPTION':
    case 'SALE':
    case 'SUPPLIER_RETURN':
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
    case 'ADJUSTMENT':
      return { onHand: qty };
    case 'RESERVE':
    case 'UNRESERVE':
      return { reserved: qty };
    case 'DAMAGE':
      return { damaged: qty };
  }
}

/** Apply bucket deltas to a starting bucket set. */
function applyDeltas(cur: StockBuckets, d: BucketDeltas): StockBuckets {
  return {
    onHand: cur.onHand + (d.onHand ?? 0),
    reserved: cur.reserved + (d.reserved ?? 0),
    inTransitIn: cur.inTransitIn + (d.inTransitIn ?? 0),
    damaged: cur.damaged + (d.damaged ?? 0),
  };
}

/**
 * Inventory — the ledger-backed stock engine (Task 2.1, DESIGN.md §4.4 / E10).
 *
 * Every stock change goes through {@link applyMovement}, which writes ONE
 * append-only stock_movements row AND updates the (branch, part) inventory
 * buckets ATOMICALLY under a `SELECT … FOR UPDATE` row lock — so N concurrent
 * movers can never oversell the last unit, and the buckets are always exactly
 * the running sum of the ledger (provably so via {@link reconcile}).
 *
 * Available stock (E10) = on_hand − reserved − damaged, derived on read and
 * never stored. Manual corrections (adjust/count) are approval-gated by value
 * (INVENTORY_ADJUSTMENT) exactly like every other sensitive action (§4.11).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ------------------------------------------------------------ write engine

  /**
   * The ONE stock write path. Ensures the (branch, part) row exists, locks it,
   * validates the resulting buckets (no bucket negative; available ≥ 0), writes
   * the new buckets and appends the ledger row — all in one transaction. Pass
   * `tx` to enlist in a caller's transaction (job consumption, GRN receipt,
   * transfers in later tasks); otherwise it opens its own.
   */
  async applyMovement(
    input: ApplyMovementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<StockMovement> {
    const run = async (t: Prisma.TransactionClient): Promise<StockMovement> => {
      // 1. Guarantee the row exists so we have something to lock (idempotent).
      //    Raw SQL bypasses the scope extension by design — company_id is
      //    passed explicitly (the caller validated branch/part tenancy).
      await t.$executeRaw`
        INSERT INTO inventory
          (id, company_id, branch_id, part_id, qty_on_hand, qty_reserved,
           qty_in_transit_in, qty_damaged, reorder_level, created_at, updated_at,
           created_by, updated_by)
        VALUES
          (${randomUUID()}, ${input.companyId}, ${input.branchId}, ${input.partId},
           0, 0, 0, 0, 0, NOW(3), NOW(3), ${input.movedById}, ${input.movedById})
        ON DUPLICATE KEY UPDATE id = id`;

      // 2. Lock the row and read current buckets (held until commit).
      const rows = await t.$queryRaw<
        Array<{
          onHand: number;
          reserved: number;
          inTransitIn: number;
          damaged: number;
        }>
      >`
        SELECT qty_on_hand AS onHand, qty_reserved AS reserved,
               qty_in_transit_in AS inTransitIn, qty_damaged AS damaged
        FROM inventory
        WHERE branch_id = ${input.branchId} AND part_id = ${input.partId}
        FOR UPDATE`;
      const cur: StockBuckets = rows[0];

      // 3. Compute + validate the next buckets.
      const next = applyDeltas(
        cur,
        movementBucketDeltas(input.type, input.qty),
      );
      assertBucketsValid(next);

      // 4. Persist the buckets (Prisma → company-scoped, stamps updated_by).
      await t.inventory.update({
        where: {
          branchId_partId: {
            branchId: input.branchId,
            partId: input.partId,
          },
        },
        data: {
          qtyOnHand: next.onHand,
          qtyReserved: next.reserved,
          qtyInTransitIn: next.inTransitIn,
          qtyDamaged: next.damaged,
          updatedById: input.movedById,
        },
      });

      // 5. Append the immutable ledger row.
      return t.stockMovement.create({
        data: {
          companyId: input.companyId,
          branchId: input.branchId,
          partId: input.partId,
          movementType: input.type,
          qty: input.qty,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          unitCost: input.unitCost ?? null,
          costCurrency: input.costCurrency ?? null,
          reason: input.reason ?? null,
          movedById: input.movedById,
        },
      });
    };

    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  // ------------------------------------------------------------------ queries

  /**
   * GET /inventory — stock rows joined to their part, with derived available
   * and low-stock flag. `low_stock=true` returns only rows at/below reorder
   * level. Uses raw SQL so `available` (a computed expression) can be filtered
   * and paginated correctly; company/branch scope is applied explicitly here
   * (raw queries bypass the scope extension, per the documented bypass rule).
   */
  async list(
    query: InventoryListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<InventoryWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const filters: Prisma.Sql[] = [
      Prisma.sql`i.company_id = ${user.companyId}`,
    ];
    if (user.scope === 'branch' && user.homeBranchId) {
      filters.push(Prisma.sql`i.branch_id = ${user.homeBranchId}`);
    }
    if (query.branch_id) {
      filters.push(Prisma.sql`i.branch_id = ${query.branch_id}`);
    }
    if (query.part_id) filters.push(Prisma.sql`i.part_id = ${query.part_id}`);
    if (query.q) {
      const like = `%${query.q}%`;
      filters.push(
        Prisma.sql`(p.part_number LIKE ${like} OR p.description LIKE ${like})`,
      );
    }
    if (query.low_stock) {
      filters.push(
        Prisma.sql`(i.qty_on_hand - i.qty_reserved - i.qty_damaged) <= i.reorder_level`,
      );
    }
    filters.push(Prisma.sql`p.deleted_at IS NULL`);
    const where = Prisma.join(filters, ' AND ');

    const countRows = await this.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n
      FROM inventory i JOIN parts p ON p.id = i.part_id
      WHERE ${where}`;
    const total = Number(countRows[0].n);

    const rows = await this.prisma.$queryRaw<InventoryRawRow[]>`
      SELECT i.id, i.branch_id AS branchId, i.part_id AS partId,
             i.bin_location AS binLocation, i.qty_on_hand AS qtyOnHand,
             i.qty_reserved AS qtyReserved, i.qty_in_transit_in AS qtyInTransitIn,
             i.qty_damaged AS qtyDamaged, i.reorder_level AS reorderLevel,
             i.updated_at AS updatedAt, p.part_number AS partNumber,
             p.description AS description, p.category AS category
      FROM inventory i JOIN parts p ON p.id = i.part_id
      WHERE ${where}
      ORDER BY p.part_number ASC, i.branch_id ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

    return {
      data: rows.map(rawToWire),
      page,
      page_size: pageSize,
      total,
    };
  }

  /** GET /inventory/{branchId}/{partId} — one stock row (404 if none). */
  async get(
    branchId: string,
    partId: string,
    user: AuthUser,
  ): Promise<InventoryWire> {
    assertBranchAccess(user, branchId);
    const row = await this.prisma.inventory.findFirst({
      where: { branchId, partId },
      include: { part: true },
    });
    if (!row)
      throw new NotFoundException('No stock record for this part/branch');
    return prismaToWire(row);
  }

  /**
   * Like get(), but returns a zero-bucket wire (not a 404) when the part has
   * no stock row at the branch yet — used by the adjust/count response paths,
   * where a HELD change or a zero-delta count legitimately leaves no row.
   */
  private async getOrEmpty(
    branchId: string,
    partId: string,
  ): Promise<InventoryWire> {
    const row = await this.prisma.inventory.findFirst({
      where: { branchId, partId },
      include: { part: true },
    });
    if (row) return prismaToWire(row);

    const part = await this.prisma.part.findFirst({
      where: { id: partId },
      select: { partNumber: true, description: true, category: true },
    });
    return {
      id: '',
      branch_id: branchId,
      part_id: partId,
      part: {
        part_number: part?.partNumber ?? '',
        description: part?.description ?? '',
        category: part?.category ?? 'HHP',
      },
      bin_location: null,
      qty_on_hand: 0,
      qty_reserved: 0,
      qty_in_transit_in: 0,
      qty_damaged: 0,
      qty_available: 0,
      reorder_level: 0,
      low_stock: true,
      updated_at: new Date(0).toISOString(),
    };
  }

  /** GET /inventory/movements — the append-only ledger, filtered + paginated. */
  async movements(
    query: MovementListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<StockMovementWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.StockMovementWhereInput = {
      companyId: user.companyId,
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.part_id ? { partId: query.part_id } : {}),
      ...(query.type ? { movementType: query.type } : {}),
      ...(query.from || query.to
        ? {
            movedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.stockMovement.count({ where }),
      this.prisma.stockMovement.findMany({
        where,
        include: { part: { select: { partNumber: true, description: true } } },
        orderBy: [{ movedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(movementToWire), page, page_size: pageSize, total };
  }

  // ---------------------------------------------------------------- mutations

  /**
   * POST /inventory/adjust — a manual stock correction (ADJUSTMENT or DAMAGE).
   * Approval-gated by the adjustment's value (|delta| × unit cost) against the
   * INVENTORY_ADJUSTMENT rule; when required, nothing moves and a PENDING
   * approval is returned (a later phase wires approval → apply, mirroring jobs).
   */
  async adjust(
    dto: AdjustStockDto,
    user: AuthUser,
  ): Promise<StockChangeResult> {
    const part = await this.resolvePart(dto.part_id);
    await this.assertBranch(dto.branch_id, user);

    const type: StockMovementType = dto.movement_type ?? 'ADJUSTMENT';
    if (type === 'DAMAGE' && dto.delta <= 0) {
      throw new BadRequestException(
        'DAMAGE requires a positive delta (units to flag as damaged)',
      );
    }
    if (type === 'ADJUSTMENT' && dto.delta === 0) {
      throw new BadRequestException('delta must be non-zero');
    }

    return this.gateAndApply(
      {
        companyId: user.companyId,
        branchId: dto.branch_id,
        partId: dto.part_id,
        type,
        qty: dto.delta,
        refType: 'ADJUSTMENT',
        reason: dto.reason,
        movedById: user.userId,
      },
      part.unitCostUsd,
      dto.reason,
    );
  }

  /**
   * POST /inventory/count — reconcile to a physical count. Computes
   * `delta = counted_qty − qty_on_hand` and posts the matching ADJUSTMENT
   * (ref_type COUNT). A zero delta is a no-op. Approval-gated like adjust().
   */
  async count(dto: StockCountDto, user: AuthUser): Promise<StockChangeResult> {
    const part = await this.resolvePart(dto.part_id);
    await this.assertBranch(dto.branch_id, user);

    const cur = await this.readBuckets(dto.branch_id, dto.part_id);
    const delta = dto.counted_qty - cur.onHand;
    const reason =
      dto.reason ??
      `Physical count reconciliation (counted ${dto.counted_qty})`;

    if (delta === 0) {
      return {
        held: false,
        movement: null,
        inventory: await this.getOrEmpty(dto.branch_id, dto.part_id),
      };
    }

    return this.gateAndApply(
      {
        companyId: user.companyId,
        branchId: dto.branch_id,
        partId: dto.part_id,
        type: 'ADJUSTMENT',
        qty: delta,
        refType: 'COUNT',
        reason,
        movedById: user.userId,
      },
      part.unitCostUsd,
      reason,
    );
  }

  /**
   * POST /inventory/reconcile — rebuild the (branch, part) buckets from the
   * full movement ledger and persist them. The ledger is the source of truth;
   * this proves it (and repairs any drift). `qty_in_transit_in` is transfer-
   * managed (not movement-derived, Task 2.3), so it is PRESERVED, not rebuilt —
   * only the three ledger buckets are recomputed. Read-mostly, but writes the
   * corrected buckets, so gated by inventory.adjust at the controller.
   */
  async reconcile(
    branchId: string,
    partId: string,
    user: AuthUser,
  ): Promise<InventoryWire> {
    await this.assertBranch(branchId, user);
    await this.resolvePart(partId);

    const movements = await this.prisma.stockMovement.findMany({
      where: { branchId, partId },
      orderBy: { movedAt: 'asc' },
    });

    let buckets: StockBuckets = {
      onHand: 0,
      reserved: 0,
      inTransitIn: 0,
      damaged: 0,
    };
    for (const m of movements) {
      buckets = applyDeltas(
        buckets,
        movementBucketDeltas(m.movementType, m.qty),
      );
    }

    await this.prisma.inventory.upsert({
      where: { branchId_partId: { branchId, partId } },
      create: {
        companyId: user.companyId,
        branchId,
        partId,
        qtyOnHand: buckets.onHand,
        qtyReserved: buckets.reserved,
        qtyDamaged: buckets.damaged,
        createdById: user.userId,
        updatedById: user.userId,
      },
      // in_transit_in intentionally omitted — preserved, not rebuilt.
      update: {
        qtyOnHand: buckets.onHand,
        qtyReserved: buckets.reserved,
        qtyDamaged: buckets.damaged,
        updatedById: user.userId,
      },
    });

    return this.get(branchId, partId, user);
  }

  /**
   * Adjust a (branch, part)'s `qty_in_transit_in` by `delta` inside a caller
   * transaction (Task 2.3 dispatch +qty / receive −qty). This bucket is NOT
   * ledger-derived, so it is written directly (never via a movement). Raw SQL
   * so it works cross-branch: dispatch bumps the DESTINATION branch, which a
   * source-branch user can't reach through the branch-scoped Prisma client —
   * company_id/branch_id are passed explicitly (validated by the caller).
   */
  async bumpInTransit(
    companyId: string,
    branchId: string,
    partId: string,
    delta: number,
    actorId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO inventory
        (id, company_id, branch_id, part_id, qty_on_hand, qty_reserved,
         qty_in_transit_in, qty_damaged, reorder_level, created_at, updated_at,
         created_by, updated_by)
      VALUES
        (${randomUUID()}, ${companyId}, ${branchId}, ${partId},
         0, 0, 0, 0, 0, NOW(3), NOW(3), ${actorId}, ${actorId})
      ON DUPLICATE KEY UPDATE id = id`;

    const rows = await tx.$queryRaw<Array<{ inTransitIn: number }>>`
      SELECT qty_in_transit_in AS inTransitIn FROM inventory
      WHERE branch_id = ${branchId} AND part_id = ${partId} FOR UPDATE`;
    const next = rows[0].inTransitIn + delta;
    if (next < 0) {
      throw new UnprocessableEntityException(
        'In-transit quantity cannot go negative',
      );
    }

    await tx.$executeRaw`
      UPDATE inventory SET qty_in_transit_in = ${next}, updated_by = ${actorId},
        updated_at = NOW(3)
      WHERE branch_id = ${branchId} AND part_id = ${partId}`;
  }

  /**
   * PATCH /inventory/settings — bin location + reorder level (no stock moves,
   * so a plain upsert, not a ledger movement). Creates the row if absent.
   */
  async settings(
    dto: InventorySettingsDto,
    user: AuthUser,
  ): Promise<InventoryWire> {
    await this.resolvePart(dto.part_id);
    await this.assertBranch(dto.branch_id, user);

    const data = {
      ...(dto.bin_location !== undefined
        ? { binLocation: dto.bin_location }
        : {}),
      ...(dto.reorder_level !== undefined
        ? { reorderLevel: dto.reorder_level }
        : {}),
    };

    await this.prisma.inventory.upsert({
      where: {
        branchId_partId: { branchId: dto.branch_id, partId: dto.part_id },
      },
      create: {
        companyId: user.companyId,
        branchId: dto.branch_id,
        partId: dto.part_id,
        binLocation: dto.bin_location ?? null,
        reorderLevel: dto.reorder_level ?? 0,
        createdById: user.userId,
        updatedById: user.userId,
      },
      update: { ...data, updatedById: user.userId },
    });

    return this.get(dto.branch_id, dto.part_id, user);
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Approval gate shared by adjust()/count(): if the change's value
   * (|qty| × unit cost, USD cents) meets the INVENTORY_ADJUSTMENT threshold,
   * hold it as a PENDING approval and move nothing; otherwise apply it.
   */
  private async gateAndApply(
    input: ApplyMovementInput,
    unitCostUsd: bigint | null,
    reason: string,
  ): Promise<StockChangeResult> {
    const value = BigInt(Math.abs(input.qty)) * (unitCostUsd ?? 0n);
    const { required } = await this.approvals.isRequired(
      'INVENTORY_ADJUSTMENT',
      {
        amount: value,
      },
    );

    if (required) {
      const approval = await this.approvals.request('INVENTORY_ADJUSTMENT', {
        branchId: input.branchId,
        refType: 'Inventory',
        refId: input.partId,
        payload: {
          branch_id: input.branchId,
          part_id: input.partId,
          movement_type: input.type,
          qty: input.qty,
          ref_type: input.refType,
          reason,
        },
        reason,
      });
      return {
        held: true,
        movement: null,
        inventory: await this.getOrEmpty(input.branchId, input.partId),
        pending_approval: approval,
      };
    }

    const movement = await this.applyMovement(input);
    return {
      held: false,
      movement: movementToWire(movement),
      inventory: await this.getOrEmpty(input.branchId, input.partId),
    };
  }

  /** Current buckets for (branch, part) — zeros when no row exists yet. */
  private async readBuckets(
    branchId: string,
    partId: string,
  ): Promise<StockBuckets> {
    const row = await this.prisma.inventory.findFirst({
      where: { branchId, partId },
    });
    return row
      ? {
          onHand: row.qtyOnHand,
          reserved: row.qtyReserved,
          inTransitIn: row.qtyInTransitIn,
          damaged: row.qtyDamaged,
        }
      : { onHand: 0, reserved: 0, inTransitIn: 0, damaged: 0 };
  }

  /** Load a part of the acting company (400 on unknown/foreign/deleted). */
  private async resolvePart(
    partId: string,
  ): Promise<{ id: string; unitCostUsd: bigint | null }> {
    const part = await this.prisma.part.findFirst({
      where: { id: partId, deletedAt: null },
      select: { id: true, unitCostUsd: true },
    });
    if (!part) {
      throw new BadRequestException(
        'part_id does not match a part of your company',
      );
    }
    return part;
  }

  /** Authorize + validate a branch of the acting company. */
  private async assertBranch(branchId: string, user: AuthUser): Promise<void> {
    assertBranchAccess(user, branchId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) {
      throw new BadRequestException(
        'branch_id does not match a branch of your company',
      );
    }
  }
}

/** A stock bucket must never go negative, and available must stay ≥ 0. */
function assertBucketsValid(next: StockBuckets): void {
  if (next.onHand < 0) {
    throw new UnprocessableEntityException('Insufficient stock on hand');
  }
  if (next.reserved < 0) {
    throw new UnprocessableEntityException(
      'Cannot unreserve more than reserved',
    );
  }
  if (next.damaged < 0) {
    throw new UnprocessableEntityException(
      'Damaged quantity cannot go negative',
    );
  }
  if (next.inTransitIn < 0) {
    throw new UnprocessableEntityException(
      'In-transit quantity cannot go negative',
    );
  }
  if (next.onHand - next.reserved - next.damaged < 0) {
    throw new UnprocessableEntityException(
      'Insufficient available stock (reserved + damaged would exceed on hand)',
    );
  }
}

/** Raw row shape returned by the list() SQL join. */
interface InventoryRawRow {
  id: string;
  branchId: string;
  partId: string;
  binLocation: string | null;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransitIn: number;
  qtyDamaged: number;
  reorderLevel: number;
  updatedAt: Date;
  partNumber: string;
  description: string;
  category: DeviceCategory;
}

function buildWire(base: {
  id: string;
  branch_id: string;
  part_id: string;
  bin_location: string | null;
  qtyOnHand: number;
  qtyReserved: number;
  qtyInTransitIn: number;
  qtyDamaged: number;
  reorderLevel: number;
  updatedAt: Date;
  part: { part_number: string; description: string; category: DeviceCategory };
}): InventoryWire {
  const available = base.qtyOnHand - base.qtyReserved - base.qtyDamaged;
  return {
    id: base.id,
    branch_id: base.branch_id,
    part_id: base.part_id,
    part: base.part,
    bin_location: base.bin_location,
    qty_on_hand: base.qtyOnHand,
    qty_reserved: base.qtyReserved,
    qty_in_transit_in: base.qtyInTransitIn,
    qty_damaged: base.qtyDamaged,
    qty_available: available,
    reorder_level: base.reorderLevel,
    low_stock: available <= base.reorderLevel,
    updated_at: base.updatedAt.toISOString(),
  };
}

function rawToWire(r: InventoryRawRow): InventoryWire {
  return buildWire({
    id: r.id,
    branch_id: r.branchId,
    part_id: r.partId,
    bin_location: r.binLocation,
    qtyOnHand: r.qtyOnHand,
    qtyReserved: r.qtyReserved,
    qtyInTransitIn: r.qtyInTransitIn,
    qtyDamaged: r.qtyDamaged,
    reorderLevel: r.reorderLevel,
    updatedAt: r.updatedAt,
    part: {
      part_number: r.partNumber,
      description: r.description,
      category: r.category,
    },
  });
}

function prismaToWire(
  row: Prisma.InventoryGetPayload<{ include: { part: true } }>,
): InventoryWire {
  return buildWire({
    id: row.id,
    branch_id: row.branchId,
    part_id: row.partId,
    bin_location: row.binLocation,
    qtyOnHand: row.qtyOnHand,
    qtyReserved: row.qtyReserved,
    qtyInTransitIn: row.qtyInTransitIn,
    qtyDamaged: row.qtyDamaged,
    reorderLevel: row.reorderLevel,
    updatedAt: row.updatedAt,
    part: {
      part_number: row.part.partNumber,
      description: row.part.description,
      category: row.part.category,
    },
  });
}

function movementToWire(
  m: StockMovement & {
    part?: { partNumber: string; description: string } | null;
  },
): StockMovementWire {
  return {
    id: m.id,
    branch_id: m.branchId,
    part_id: m.partId,
    part: m.part
      ? { part_number: m.part.partNumber, description: m.part.description }
      : null,
    movement_type: m.movementType,
    qty: m.qty,
    ref_type: m.refType,
    ref_id: m.refId,
    unit_cost: m.unitCost?.toString() ?? null,
    cost_currency: m.costCurrency,
    reason: m.reason,
    moved_by: m.movedById,
    moved_at: m.movedAt.toISOString(),
  };
}
