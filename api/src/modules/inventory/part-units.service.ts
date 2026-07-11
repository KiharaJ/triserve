import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PartUnitStatus } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { assertBranchAccess } from '../../common/authz/branch-access';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  PartUnitListQueryDto,
  RegisterUnitsDto,
  UpdatePartUnitDto,
} from './dto/part-unit.dto';

const DEFAULT_PAGE_SIZE = 20;

/** Wire shape of one tracked serial/batch unit (snake_case). */
export interface PartUnitWire {
  id: string;
  part_id: string;
  part: { part_number: string; description: string };
  serial_no: string;
  branch_id: string;
  branch_code: string;
  status: PartUnitStatus;
  supplier_id: string | null;
  grn_id: string | null;
  installed_on_job_id: string | null;
  removed_from_job_id: string | null;
  warranty_expiry: string | null;
  created_at: string;
}

type UnitFull = Prisma.PartUnitGetPayload<{
  include: { part: true; branch: true };
}>;

const FULL_INCLUDE = { part: true, branch: true } as const;

/**
 * Serial/batch unit tracking (Task 2.4, DESIGN.md §4.4 / E11) for parts flagged
 * is_serialized. An OVERLAY registry over the quantity ledger: each high-value
 * unit is one row with an identity (serial), a current location, provenance
 * (supplier/GRN) and lifecycle status (IN_STOCK → RESERVED → INSTALLED /
 * RETURNED / DAMAGED) — supporting recall handling, "which exact unit failed"
 * and per-unit warranty. Company-scoped (not branch-scoped) so a serial's
 * history is visible group-wide for lookup.
 */
@Injectable()
export class PartUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /part-units — filtered, paginated; `serial` is the recall lookup. */
  async list(
    query: PartUnitListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<PartUnitWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.PartUnitWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.part_id ? { partId: query.part_id } : {}),
      ...(query.branch_id ? { branchId: query.branch_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.serial ? { serialNo: { contains: query.serial } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.partUnit.count({ where }),
      this.prisma.partUnit.findMany({
        where,
        include: FULL_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /part-units/{id}. */
  async get(id: string, user: AuthUser): Promise<PartUnitWire> {
    void user;
    const unit = await this.prisma.partUnit.findFirst({
      where: { id, deletedAt: null },
      include: FULL_INCLUDE,
    });
    if (!unit) throw new NotFoundException('Part unit not found');
    return toWire(unit);
  }

  /** POST /parts/{partId}/units — register serial units into stock. */
  async register(
    partId: string,
    dto: RegisterUnitsDto,
    user: AuthUser,
  ): Promise<PartUnitWire[]> {
    const part = await this.prisma.part.findFirst({
      where: { id: partId, deletedAt: null },
      select: { id: true, isSerialized: true },
    });
    if (!part) {
      throw new BadRequestException(
        'part_id does not match a part of your company',
      );
    }
    if (!part.isSerialized) {
      throw new BadRequestException(
        'This part is not serial-tracked (set is_serialized first)',
      );
    }

    const branchId = dto.branch_id ?? user.homeBranchId;
    if (!branchId) {
      throw new BadRequestException(
        'branch_id is required (your account has no home branch)',
      );
    }
    assertBranchAccess(user, branchId);
    await this.assertBranchInCompany(branchId);
    if (dto.supplier_id) await this.assertSupplier(dto.supplier_id);
    if (dto.grn_id) await this.assertGrn(dto.grn_id);

    const serials = dto.serials.map((s) => s.trim()).filter(Boolean);
    if (new Set(serials).size !== serials.length) {
      throw new BadRequestException('The serials list contains duplicates');
    }
    const existing = await this.prisma.partUnit.findMany({
      where: { partId, serialNo: { in: serials }, deletedAt: null },
      select: { serialNo: true },
    });
    if (existing.length > 0) {
      throw new ConflictException(
        `Already registered for this part: ${existing
          .map((e) => e.serialNo)
          .join(', ')}`,
      );
    }

    const warrantyExpiry = dto.warranty_expiry
      ? new Date(dto.warranty_expiry)
      : null;

    // create() per row (not createMany) — PartUnit is audited, so each unit
    // gets its own CREATE audit row.
    const created: UnitFull[] = [];
    for (const serialNo of serials) {
      created.push(
        await this.prisma.partUnit.create({
          data: {
            companyId: user.companyId,
            partId,
            serialNo,
            branchId,
            status: 'IN_STOCK',
            supplierId: dto.supplier_id ?? null,
            grnId: dto.grn_id ?? null,
            warrantyExpiry,
            createdById: user.userId,
            updatedById: user.userId,
          },
          include: FULL_INCLUDE,
        }),
      );
    }
    return created.map(toWire);
  }

  /** PATCH /part-units/{id} — status / location / warranty / job linkage. */
  async update(
    id: string,
    dto: UpdatePartUnitDto,
    user: AuthUser,
  ): Promise<PartUnitWire> {
    const unit = await this.prisma.partUnit.findFirst({
      where: { id, deletedAt: null },
    });
    if (!unit) throw new NotFoundException('Part unit not found');
    if (dto.branch_id) {
      assertBranchAccess(user, dto.branch_id);
      await this.assertBranchInCompany(dto.branch_id);
    }

    await this.prisma.partUnit.update({
      where: { id },
      data: {
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.branch_id !== undefined ? { branchId: dto.branch_id } : {}),
        ...(dto.warranty_expiry !== undefined
          ? {
              warrantyExpiry: dto.warranty_expiry
                ? new Date(dto.warranty_expiry)
                : null,
            }
          : {}),
        ...(dto.installed_on_job_id !== undefined
          ? { installedOnJobId: dto.installed_on_job_id }
          : {}),
        ...(dto.removed_from_job_id !== undefined
          ? { removedFromJobId: dto.removed_from_job_id }
          : {}),
        updatedById: user.userId,
      },
    });
    return this.get(id, user);
  }

  // ------------------------------------------------------------------ helpers

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

  private async assertSupplier(supplierId: string): Promise<void> {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: supplierId, deletedAt: null },
    });
    if (!supplier) {
      throw new BadRequestException(
        'supplier_id does not match a supplier of your company',
      );
    }
  }

  private async assertGrn(grnId: string): Promise<void> {
    const grn = await this.prisma.goodsReceivedNote.findFirst({
      where: { id: grnId },
    });
    if (!grn) {
      throw new BadRequestException(
        'grn_id does not match a GRN of your company',
      );
    }
  }
}

function toWire(u: UnitFull): PartUnitWire {
  return {
    id: u.id,
    part_id: u.partId,
    part: { part_number: u.part.partNumber, description: u.part.description },
    serial_no: u.serialNo,
    branch_id: u.branchId,
    branch_code: u.branch.code,
    status: u.status,
    supplier_id: u.supplierId,
    grn_id: u.grnId,
    installed_on_job_id: u.installedOnJobId,
    removed_from_job_id: u.removedFromJobId,
    warranty_expiry: u.warrantyExpiry
      ? u.warrantyExpiry.toISOString().slice(0, 10)
      : null,
    created_at: u.createdAt.toISOString(),
  };
}
