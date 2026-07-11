import { BadRequestException, Injectable } from '@nestjs/common';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';

/** One part that has fallen to/below its reorder level. */
export interface ReorderItem {
  part_id: string;
  part_number: string;
  description: string;
  available: number;
  reorder_level: number;
  /** Heuristic order qty to bring stock back up (see computeSuggestedQty). */
  suggested_qty: number;
  unit_cost_usd: string | null;
}

/** Reorder candidates grouped by the parts' preferred supplier. */
export interface ReorderGroup {
  supplier_id: string | null;
  supplier_name: string | null;
  currency: string | null;
  items: ReorderItem[];
}

export interface ReorderSuggestions {
  branch_id: string;
  branch_code: string;
  groups: ReorderGroup[];
}

interface ReorderRawRow {
  partId: string;
  partNumber: string;
  description: string;
  /** MySQL types the on_hand−reserved−damaged arithmetic as BIGINT → coerce. */
  available: bigint | number;
  reorderLevel: number;
  unitCostUsd: bigint | null;
  preferredSupplierId: string | null;
  supplierName: string | null;
  supplierCurrency: string | null;
}

/**
 * Reorder suggestions (Task 2.9, DESIGN.md §4.4b). For a branch, every active
 * part whose available stock (on_hand − reserved − damaged) has fallen to or
 * below its reorder level, grouped by preferred supplier with a suggested order
 * quantity — the raw material for a one-click purchase order. Uses live stock
 * (the buckets projected from the movement ledger), so it is always current.
 */
@Injectable()
export class ReorderService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /reorder-suggestions?branch_id= */
  async suggestions(
    branchId: string | undefined,
    user: AuthUser,
  ): Promise<ReorderSuggestions> {
    const effectiveBranchId = branchId ?? user.homeBranchId;
    if (!effectiveBranchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, effectiveBranchId);

    // Raw SQL so `available` (a computed expression) can be filtered; company/
    // branch scope is applied explicitly (raw queries bypass the extension).
    const rows = await this.prisma.$queryRaw<ReorderRawRow[]>`
      SELECT i.part_id AS partId,
             p.part_number AS partNumber, p.description AS description,
             (i.qty_on_hand - i.qty_reserved - i.qty_damaged) AS available,
             i.reorder_level AS reorderLevel, p.unit_cost_usd AS unitCostUsd,
             p.preferred_supplier_id AS preferredSupplierId,
             s.name AS supplierName, s.default_currency AS supplierCurrency
      FROM inventory i
      JOIN parts p ON p.id = i.part_id AND p.deleted_at IS NULL AND p.active = 1
      LEFT JOIN suppliers s
        ON s.id = p.preferred_supplier_id AND s.deleted_at IS NULL
      WHERE i.company_id = ${user.companyId}
        AND i.branch_id = ${effectiveBranchId}
        AND i.reorder_level > 0
        AND (i.qty_on_hand - i.qty_reserved - i.qty_damaged) <= i.reorder_level
      ORDER BY s.name IS NULL, s.name ASC, p.part_number ASC`;

    const branch = await this.prisma.branch.findFirstOrThrow({
      where: { id: effectiveBranchId },
      select: { code: true },
    });

    return {
      branch_id: effectiveBranchId,
      branch_code: branch.code,
      groups: groupBySupplier(rows),
    };
  }
}

/**
 * Suggested order quantity: bring available back up to TWICE the reorder level
 * (a full buffer above the reorder point), at least 1. Parts have no explicit
 * max/reorder-qty column, so this is a sensible default the buyer can edit.
 */
export function computeSuggestedQty(
  available: number,
  reorderLevel: number,
): number {
  return Math.max(reorderLevel * 2 - available, 1);
}

function groupBySupplier(rows: ReorderRawRow[]): ReorderGroup[] {
  const byKey = new Map<string, ReorderGroup>();
  for (const r of rows) {
    const key = r.preferredSupplierId ?? '__none__';
    let group = byKey.get(key);
    if (!group) {
      group = {
        supplier_id: r.preferredSupplierId,
        supplier_name: r.supplierName,
        currency: r.supplierCurrency,
        items: [],
      };
      byKey.set(key, group);
    }
    const available = Number(r.available);
    const reorderLevel = Number(r.reorderLevel);
    group.items.push({
      part_id: r.partId,
      part_number: r.partNumber,
      description: r.description,
      available,
      reorder_level: reorderLevel,
      suggested_qty: computeSuggestedQty(available, reorderLevel),
      unit_cost_usd: r.unitCostUsd?.toString() ?? null,
    });
  }
  return [...byKey.values()];
}
