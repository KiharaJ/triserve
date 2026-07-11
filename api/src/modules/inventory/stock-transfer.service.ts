import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type StockTransferStatus } from '@prisma/client';
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
  CreateTransferDto,
  TransferListQueryDto,
} from './dto/transfer.dto';
import { InventoryService } from './inventory.service';

const DEFAULT_PAGE_SIZE = 20;

export interface TransferLineWire {
  id: string;
  part_id: string;
  part: { part_number: string; description: string };
  qty: number;
}

export interface TransferWire {
  id: string;
  transfer_no: string;
  from_branch_id: string;
  from_branch_code: string;
  to_branch_id: string;
  to_branch_code: string;
  status: StockTransferStatus;
  notes: string | null;
  dispatched_at: string | null;
  dispatched_by: string | null;
  received_at: string | null;
  received_by: string | null;
  created_at: string;
  lines: TransferLineWire[];
}

/** Result of a dispatch — applied, or HELD pending approval (§4.11). */
export interface TransferDispatchResult {
  held: boolean;
  transfer: TransferWire;
  pending_approval?: ApprovalEntry;
}

type TransferFull = Prisma.StockTransferGetPayload<{
  include: {
    fromBranch: true;
    toBranch: true;
    lines: { include: { part: true } };
  };
}>;

const FULL_INCLUDE = {
  fromBranch: true,
  toBranch: true,
  lines: { include: { part: true } },
} as const;

/**
 * Inter-branch stock transfers (Task 2.3, DESIGN.md §4.4).
 *
 * DRAFT → DISPATCHED → RECEIVED (or DRAFT → CANCELLED). Dispatch posts a
 * TRANSFER_OUT at the source and bumps the destination's in-transit bucket;
 * receive posts a TRANSFER_IN at the destination and clears in-transit — every
 * stock effect through InventoryService in ONE transaction with the status
 * change (ref_type TRANSFER). Dispatch is approval-gated by value
 * (STOCK_TRANSFER). Branch-scoped users only see/act on transfers involving
 * their branch: create/dispatch/cancel require the SOURCE branch, receive the
 * DESTINATION branch.
 */
@Injectable()
export class StockTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ------------------------------------------------------------------ queries

  /** GET /transfers — company-scoped; branch users see from/to = their branch. */
  async list(
    query: TransferListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<TransferWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.StockTransferWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { transferNo: { contains: query.q } } : {}),
      ...(query.branch_id
        ? {
            OR: [
              { fromBranchId: query.branch_id },
              { toBranchId: query.branch_id },
            ],
          }
        : {}),
    };
    // A branch-scoped user only sees transfers touching their branch.
    if (user.scope === 'branch' && user.homeBranchId) {
      where.AND = [
        {
          OR: [
            { fromBranchId: user.homeBranchId },
            { toBranchId: user.homeBranchId },
          ],
        },
      ];
    }

    const [total, rows] = await Promise.all([
      this.prisma.stockTransfer.count({ where }),
      this.prisma.stockTransfer.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /transfers/{id}. */
  async get(id: string, user: AuthUser): Promise<TransferWire> {
    return toWire(await this.loadForAction(id, user));
  }

  // ---------------------------------------------------------------- mutations

  /** POST /transfers — draft a transfer (no stock moves yet). */
  async create(dto: CreateTransferDto, user: AuthUser): Promise<TransferWire> {
    if (dto.from_branch_id === dto.to_branch_id) {
      throw new BadRequestException(
        'from_branch_id and to_branch_id must differ',
      );
    }
    // A branch user can only send FROM their own branch.
    assertBranchAccess(user, dto.from_branch_id);
    await this.assertBranchInCompany(user.companyId, dto.from_branch_id);
    await this.assertBranchInCompany(user.companyId, dto.to_branch_id);

    const partIds = dto.lines.map((l) => l.part_id);
    if (new Set(partIds).size !== partIds.length) {
      throw new BadRequestException('A part appears more than once in lines');
    }
    const parts = await this.prisma.part.findMany({
      where: { id: { in: partIds }, deletedAt: null },
      select: { id: true },
    });
    if (parts.length !== partIds.length) {
      throw new BadRequestException(
        'One or more part_id does not match a part of your company',
      );
    }

    const transferNo = await this.generateTransferNo(
      user.companyId,
      new Date().getFullYear(),
    );

    const created = await this.prisma.stockTransfer.create({
      data: {
        companyId: user.companyId,
        transferNo,
        fromBranchId: dto.from_branch_id,
        toBranchId: dto.to_branch_id,
        status: 'DRAFT',
        notes: dto.notes ?? null,
        createdById: user.userId,
        updatedById: user.userId,
        lines: {
          create: dto.lines.map((l) => ({ partId: l.part_id, qty: l.qty })),
        },
      },
      include: FULL_INCLUDE,
    });
    return toWire(created);
  }

  /**
   * POST /transfers/{id}/dispatch — send the stock (TRANSFER_OUT at source +
   * in-transit at destination). Approval-gated by value; when held, the status
   * stays DRAFT and nothing moves.
   */
  async dispatch(id: string, user: AuthUser): Promise<TransferDispatchResult> {
    const t = await this.loadForAction(id, user);
    if (t.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT transfer can be dispatched');
    }
    assertBranchAccess(user, t.fromBranchId);

    const value = transferValue(t);
    const { required } = await this.approvals.isRequired('STOCK_TRANSFER', {
      amount: value,
    });
    if (required) {
      const approval = await this.approvals.request('STOCK_TRANSFER', {
        branchId: t.fromBranchId,
        refType: 'StockTransfer',
        refId: t.id,
        payload: {
          transfer_no: t.transferNo,
          from_branch_id: t.fromBranchId,
          to_branch_id: t.toBranchId,
          lines: t.lines.map((l) => ({ part_id: l.partId, qty: l.qty })),
        },
        reason: `Dispatch transfer ${t.transferNo} to ${t.toBranch.code}`,
      });
      return {
        held: true,
        transfer: await this.get(id, user),
        pending_approval: approval,
      };
    }

    await this.prisma.$transaction(async (tx) => {
      for (const line of t.lines) {
        await this.inventory.applyMovement(
          {
            companyId: user.companyId,
            branchId: t.fromBranchId,
            partId: line.partId,
            type: 'TRANSFER_OUT',
            qty: -line.qty,
            refType: 'TRANSFER',
            refId: t.id,
            unitCost: line.part.unitCostUsd,
            costCurrency: line.part.unitCostUsd !== null ? 'USD' : null,
            reason: `Transfer ${t.transferNo} → ${t.toBranch.code}`,
            movedById: user.userId,
          },
          tx,
        );
        await this.inventory.bumpInTransit(
          user.companyId,
          t.toBranchId,
          line.partId,
          line.qty,
          user.userId,
          tx,
        );
      }
      await tx.stockTransfer.update({
        where: { id: t.id },
        data: {
          status: 'DISPATCHED',
          dispatchedAt: new Date(),
          dispatchedById: user.userId,
          updatedById: user.userId,
        },
      });
    });

    return { held: false, transfer: await this.get(id, user) };
  }

  /**
   * POST /transfers/{id}/receive — land the stock at the destination
   * (TRANSFER_IN + clear in-transit). Requires the destination branch.
   */
  async receive(id: string, user: AuthUser): Promise<TransferWire> {
    const t = await this.loadForAction(id, user);
    if (t.status !== 'DISPATCHED') {
      throw new ConflictException('Only a DISPATCHED transfer can be received');
    }
    assertBranchAccess(user, t.toBranchId);

    await this.prisma.$transaction(async (tx) => {
      for (const line of t.lines) {
        await this.inventory.applyMovement(
          {
            companyId: user.companyId,
            branchId: t.toBranchId,
            partId: line.partId,
            type: 'TRANSFER_IN',
            qty: line.qty,
            refType: 'TRANSFER',
            refId: t.id,
            unitCost: line.part.unitCostUsd,
            costCurrency: line.part.unitCostUsd !== null ? 'USD' : null,
            reason: `Transfer ${t.transferNo} ← ${t.fromBranch.code}`,
            movedById: user.userId,
          },
          tx,
        );
        await this.inventory.bumpInTransit(
          user.companyId,
          t.toBranchId,
          line.partId,
          -line.qty,
          user.userId,
          tx,
        );
      }
      await tx.stockTransfer.update({
        where: { id: t.id },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          receivedById: user.userId,
          updatedById: user.userId,
        },
      });
    });

    return this.get(id, user);
  }

  /** POST /transfers/{id}/cancel — cancel a DRAFT (no stock moved yet). */
  async cancel(id: string, user: AuthUser): Promise<TransferWire> {
    const t = await this.loadForAction(id, user);
    if (t.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT transfer can be cancelled');
    }
    assertBranchAccess(user, t.fromBranchId);
    await this.prisma.stockTransfer.update({
      where: { id: t.id },
      data: { status: 'CANCELLED', updatedById: user.userId },
    });
    return this.get(id, user);
  }

  // ------------------------------------------------------------------ helpers

  /** Load a transfer of the acting tenant; branch users must be from/to it. */
  private async loadForAction(
    id: string,
    user: AuthUser,
  ): Promise<TransferFull> {
    const t = await this.prisma.stockTransfer.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!t) throw new NotFoundException('Transfer not found');
    if (
      user.scope === 'branch' &&
      user.homeBranchId &&
      t.fromBranchId !== user.homeBranchId &&
      t.toBranchId !== user.homeBranchId
    ) {
      throw new NotFoundException('Transfer not found');
    }
    return t;
  }

  /**
   * Confirm a branch belongs to the company — raw SQL with an explicit
   * company_id, because a transfer references the DESTINATION branch, which the
   * branch-scope extension would hide from a branch-scoped user (it restricts
   * their Branch reads to their home branch only). Company membership, not
   * access, is what matters here (access is enforced separately per action).
   */
  private async assertBranchInCompany(
    companyId: string,
    branchId: string,
  ): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM branches
      WHERE id = ${branchId} AND company_id = ${companyId}
        AND deleted_at IS NULL LIMIT 1`;
    if (rows.length === 0) {
      throw new BadRequestException(
        'branch_id does not match a branch of your company',
      );
    }
  }

  /**
   * Concurrency-safe transfer_no: `TRF-{YYYY}-{seq padded to 6}` per (company,
   * year), via the same atomic MySQL sequence idiom as job_no.
   */
  private async generateTransferNo(
    companyId: string,
    year: number,
  ): Promise<string> {
    const seq = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO transfer_counters (id, company_id, year, next_seq, created_at, updated_at)
        VALUES (${randomUUID()}, ${companyId}, ${year}, LAST_INSERT_ID(1), NOW(3), NOW(3))
        ON DUPLICATE KEY UPDATE next_seq = LAST_INSERT_ID(next_seq + 1), updated_at = NOW(3)`;
      const rows = await tx.$queryRaw<
        Array<{ seq: bigint }>
      >`SELECT LAST_INSERT_ID() AS seq`;
      return Number(rows[0].seq);
    });
    return `TRF-${year}-${String(seq).padStart(6, '0')}`;
  }
}

/** Total value of a transfer in USD cents (Σ qty × unit_cost_usd). */
function transferValue(t: TransferFull): bigint {
  return t.lines.reduce(
    (sum, l) => sum + BigInt(l.qty) * (l.part.unitCostUsd ?? 0n),
    0n,
  );
}

function toWire(t: TransferFull): TransferWire {
  return {
    id: t.id,
    transfer_no: t.transferNo,
    from_branch_id: t.fromBranchId,
    from_branch_code: t.fromBranch.code,
    to_branch_id: t.toBranchId,
    to_branch_code: t.toBranch.code,
    status: t.status,
    notes: t.notes,
    dispatched_at: t.dispatchedAt?.toISOString() ?? null,
    dispatched_by: t.dispatchedById,
    received_at: t.receivedAt?.toISOString() ?? null,
    received_by: t.receivedById,
    created_at: t.createdAt.toISOString(),
    lines: t.lines.map((l) => ({
      id: l.id,
      part_id: l.partId,
      part: {
        part_number: l.part.partNumber,
        description: l.part.description,
      },
      qty: l.qty,
    })),
  };
}
