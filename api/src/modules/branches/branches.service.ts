import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Branch } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  BranchListQueryDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

/** Wire shape of one branch (snake_case per API convention). */
export interface BranchWire {
  id: string;
  code: string;
  name: string;
  is_hq: boolean;
  address: string | null;
  phone: string | null;
  tz_region: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * Branch admin (Task 0.7, DESIGN.md §4.1). Company-scoped via the Prisma
 * scope extension (branch-scoped users are additionally pinned to their
 * home branch); mutations are audited automatically (Branch ∈
 * AUDITED_MODELS). No hard delete — branches are deactivated instead
 * (soft-delete convention; history must keep resolving).
 */
@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /branches — paginated, `q` matches code/name. */
  async list(
    query: BranchListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<BranchWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId set explicitly AND re-tightened by the scope extension.
    const where: Prisma.BranchWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.active !== undefined ? { active: query.active } : {}),
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
      this.prisma.branch.count({ where }),
      this.prisma.branch.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /branches/{id}. */
  async get(id: string): Promise<BranchWire> {
    const branch = await this.prisma.branch.findFirst({
      where: { id, deletedAt: null },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return toWire(branch);
  }

  /** POST /branches. */
  async create(dto: CreateBranchDto, user: AuthUser): Promise<BranchWire> {
    try {
      const branch = await this.prisma.branch.create({
        data: {
          companyId: user.companyId, // also force-injected by the extension
          code: dto.code.toUpperCase(),
          name: dto.name,
          isHq: dto.is_hq ?? false,
          address: dto.address ?? null,
          phone: dto.phone ?? null,
          tzRegion: dto.tz_region ?? null,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return toWire(branch);
    } catch (e) {
      throw mapUniqueCode(e);
    }
  }

  /** PATCH /branches/{id}. */
  async update(
    id: string,
    dto: UpdateBranchDto,
    user: AuthUser,
  ): Promise<BranchWire> {
    await this.get(id); // clean 404 (scope extension pins the read)

    try {
      const branch = await this.prisma.branch.update({
        where: { id },
        data: {
          ...(dto.code !== undefined ? { code: dto.code.toUpperCase() } : {}),
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.is_hq !== undefined ? { isHq: dto.is_hq } : {}),
          ...(dto.address !== undefined ? { address: dto.address } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(dto.tz_region !== undefined ? { tzRegion: dto.tz_region } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedById: user.userId,
        },
      });
      return toWire(branch);
    } catch (e) {
      throw mapUniqueCode(e);
    }
  }
}

/** P2002 on (company_id, code) → 409 with a human message. */
function mapUniqueCode(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException(
      'A branch with this code already exists for this company',
    );
  }
  return e;
}

function toWire(b: Branch): BranchWire {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    is_hq: b.isHq,
    address: b.address,
    phone: b.phone,
    tz_region: b.tzRegion,
    active: b.active,
    created_at: b.createdAt.toISOString(),
    updated_at: b.updatedAt.toISOString(),
  };
}
