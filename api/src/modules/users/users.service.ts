import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type User,
  type UserRole,
  type UserScope,
} from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type {
  CreateUserDto,
  UpdateUserDto,
  UserListQueryDto,
} from './dto/user.dto';

/**
 * Wire shape of one user for the admin screens (snake_case). NEVER carries
 * password_hash or totp_secret — those never leave the API.
 */
export interface UserWire {
  id: string;
  full_name: string;
  initials: string | null;
  email: string;
  phone: string | null;
  role: UserRole;
  scope: UserScope;
  home_branch_id: string | null;
  totp_enabled: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PAGE_SIZE = 20;

/**
 * User admin (Task 0.7, DESIGN.md §3/§4.1). Company-scoped via the Prisma
 * scope extension; mutations audited automatically (User ∈ AUDITED_MODELS,
 * password_hash/totp_secret snapshots are REDACTED by the audit extension).
 * Deactivation replaces deletion (soft-delete convention) and revokes the
 * user's live sessions so a disabled account cannot keep refreshing.
 */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /users — filter by role/branch/active, `q` matches name/email. */
  async list(
    query: UserListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<UserWire>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;

    const where: Prisma.UserWhereInput = {
      companyId: user.companyId, // re-tightened by the scope extension
      deletedAt: null,
      ...(query.role ? { role: query.role } : {}),
      ...(query.branch_id ? { homeBranchId: query.branch_id } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q } },
              { email: { contains: query.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ fullName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { data: rows.map(toWire), page, page_size: pageSize, total };
  }

  /** GET /users/{id}. */
  async get(id: string): Promise<UserWire> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('User not found');
    return toWire(row);
  }

  /** POST /users. */
  async create(dto: CreateUserDto, actor: AuthUser): Promise<UserWire> {
    const homeBranchId = await this.resolveHomeBranch(
      dto.scope,
      dto.home_branch_id ?? null,
    );
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    try {
      const row = await this.prisma.user.create({
        data: {
          companyId: actor.companyId, // also force-injected by the extension
          fullName: dto.full_name,
          initials: dto.initials ?? null,
          email: dto.email.toLowerCase(),
          phone: dto.phone ?? null,
          passwordHash,
          role: dto.role,
          scope: dto.scope,
          homeBranchId,
          createdById: actor.userId,
          updatedById: actor.userId,
        },
      });
      return toWire(row);
    } catch (e) {
      throw mapUniqueEmail(e);
    }
  }

  /** PATCH /users/{id}. */
  async update(
    id: string,
    dto: UpdateUserDto,
    actor: AuthUser,
  ): Promise<UserWire> {
    const before = await this.findRow(id);

    const nextScope = dto.scope ?? before.scope;
    const nextHomeBranchId =
      dto.home_branch_id !== undefined
        ? await this.resolveHomeBranch(nextScope, dto.home_branch_id)
        : dto.scope === 'branch' && !before.homeBranchId
          ? await this.resolveHomeBranch(nextScope, null) // fails loudly
          : before.homeBranchId;

    const passwordHash = dto.password
      ? await argon2.hash(dto.password, { type: argon2.argon2id })
      : undefined;

    try {
      const row = await this.prisma.user.update({
        where: { id },
        data: {
          ...(dto.full_name !== undefined ? { fullName: dto.full_name } : {}),
          ...(dto.initials !== undefined ? { initials: dto.initials } : {}),
          ...(dto.email !== undefined
            ? { email: dto.email.toLowerCase() }
            : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          ...(passwordHash ? { passwordHash } : {}),
          ...(dto.role !== undefined ? { role: dto.role } : {}),
          ...(dto.scope !== undefined ? { scope: dto.scope } : {}),
          homeBranchId: nextHomeBranchId,
          updatedById: actor.userId,
        },
      });
      return toWire(row);
    } catch (e) {
      throw mapUniqueEmail(e);
    }
  }

  /**
   * POST /users/{id}/activate | /deactivate. Deactivation revokes every
   * live session (a disabled account must not keep refreshing tokens) and
   * refuses to lock out the acting admin themselves.
   */
  async setActive(
    id: string,
    active: boolean,
    actor: AuthUser,
  ): Promise<UserWire> {
    if (!active && id === actor.userId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    await this.findRow(id);

    const row = await this.prisma.user.update({
      where: { id },
      data: { active, updatedById: actor.userId },
    });

    if (!active) {
      // Session is deliberately outside the company-scope/audit extensions
      // (auth infrastructure): revoke directly by user id.
      await this.prisma.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return toWire(row);
  }

  private async findRow(id: string): Promise<User> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  /**
   * scope='branch' requires a home branch; when given, the branch must be
   * an existing, non-deleted branch of the caller's company (the scope
   * extension pins the lookup, so a foreign id 400s rather than leaking).
   */
  private async resolveHomeBranch(
    scope: UserScope,
    homeBranchId: string | null,
  ): Promise<string | null> {
    if (!homeBranchId) {
      if (scope === 'branch') {
        throw new BadRequestException(
          'home_branch_id is required for branch-scoped users',
        );
      }
      return null;
    }
    const branch = await this.prisma.branch.findFirst({
      where: { id: homeBranchId, deletedAt: null },
    });
    if (!branch) {
      throw new BadRequestException('Unknown branch for this company');
    }
    return branch.id;
  }
}

/** P2002 on email → 409 with a human message. */
function mapUniqueEmail(e: unknown): unknown {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return new ConflictException('A user with this email already exists');
  }
  return e;
}

function toWire(u: User): UserWire {
  return {
    id: u.id,
    full_name: u.fullName,
    initials: u.initials,
    email: u.email,
    phone: u.phone,
    role: u.role,
    scope: u.scope,
    home_branch_id: u.homeBranchId,
    totp_enabled: u.totpEnabled,
    active: u.active,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
  };
}
