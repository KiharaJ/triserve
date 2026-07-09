import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type DeviceModel } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateModelDto, ModelListQueryDto } from './dto/model.dto';

/** Wire shape of one model (snake_case per API convention). */
export interface ModelWire {
  id: string;
  model_code: string;
  category: string;
  brand: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * The `models` lookup (Task 1.1, DESIGN.md §4.2) — company-level config
 * normalising the messy free-text device model column. Company-scoped via
 * the Prisma scope extension; mutations audited (DeviceModel ∈
 * AUDITED_MODELS). Creation is admin/manager-gated ('model.manage').
 */
@Injectable()
export class ModelsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /models — paginated; `q` matches model_code/brand. */
  async list(
    query: ModelListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<ModelWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    // companyId set explicitly AND re-tightened by the scope extension.
    const where: Prisma.DeviceModelWhereInput = {
      companyId: user.companyId,
      deletedAt: null,
      ...(query.category ? { category: query.category } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { modelCode: { contains: query.q } },
              { brand: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.deviceModel.count({ where }),
      this.prisma.deviceModel.findMany({
        where,
        orderBy: [{ brand: 'asc' }, { modelCode: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** POST /models. */
  async create(dto: CreateModelDto, user: AuthUser): Promise<ModelWire> {
    try {
      const model = await this.prisma.deviceModel.create({
        data: {
          companyId: user.companyId, // also force-injected by the extension
          modelCode: dto.model_code,
          category: dto.category,
          brand: dto.brand ?? 'Samsung',
          active: dto.active ?? true,
          createdById: user.userId,
          updatedById: user.userId,
        },
      });
      return toWire(model);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'A model with this brand and model_code already exists for this company',
        );
      }
      throw e;
    }
  }
}

function toWire(m: DeviceModel): ModelWire {
  return {
    id: m.id,
    model_code: m.modelCode,
    category: m.category,
    brand: m.brand,
    active: m.active,
    created_at: m.createdAt.toISOString(),
    updated_at: m.updatedAt.toISOString(),
  };
}
