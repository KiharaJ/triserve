import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Role } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  defaultPermissionsFor,
  isBuiltinRole,
  isRoleEditable,
  isValidRoleKey,
  resolveEffectivePermissions,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  roleKeyFromLabel,
  type Permission,
  type PermissionOverride,
  type RoleMatrixEntry,
  type RoleName,
  type RolesMatrixResponse,
} from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Roles admin (E17/E17b) — the per-company role registry and its permission
 * matrix. Roles come from the `roles` table (built-ins seeded, customs added
 * here); enforcement lives in {@link PermissionResolverService}. This service
 * reconciles the persisted permission DELTA (`role_permissions`) and keeps the
 * resolver's cache fresh.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
  ) {}

  /** GET /roles — every role for the acting company, with its matrix. */
  async matrix(actor: AuthUser): Promise<RolesMatrixResponse> {
    const [rows, overrides, counts] = await Promise.all([
      this.prisma.role.findMany({ orderBy: [{ isSystem: 'desc' }, { key: 'asc' }] }),
      this.resolver.listOverrides(actor.companyId),
      this.userCountsByRole(),
    ]);
    return {
      roles: rows.map((r) => buildEntry(r, overrides, counts.get(r.key) ?? 0)),
    };
  }

  /** POST /roles — create a custom role, optionally cloning/seeding permissions. */
  async createRole(dto: CreateRoleDto, actor: AuthUser): Promise<RoleMatrixEntry> {
    const key = (dto.key ?? roleKeyFromLabel(dto.label)).toUpperCase();
    if (!isValidRoleKey(key)) {
      throw new BadRequestException(
        'Could not derive a valid role key from the label — provide an explicit key',
      );
    }

    const existing = await this.prisma.role.findFirst({ where: { key } });
    if (existing) {
      throw new ConflictException(`A role with key "${key}" already exists`);
    }

    // Resolve the permission set the new role should start with.
    let seed: Permission[];
    if (dto.clone_from) {
      const source = await this.prisma.role.findFirst({
        where: { key: dto.clone_from },
      });
      if (!source) {
        throw new BadRequestException(`Unknown role to clone: ${dto.clone_from}`);
      }
      seed = await this.resolver.effectiveForRole(actor.companyId, dto.clone_from);
    } else {
      seed = dto.permissions ?? [];
    }

    const role = await this.prisma.role.create({
      data: {
        companyId: actor.companyId,
        key,
        label: dto.label.trim(),
        description: dto.description?.trim() || null,
        isSystem: false,
        createdById: actor.userId,
        updatedById: actor.userId,
      },
    });

    // A custom role has an empty default, so every seeded permission is a
    // granted=true override row.
    for (const permission of ALL_PERMISSIONS) {
      if (!seed.includes(permission)) continue;
      await this.prisma.rolePermission.create({
        data: {
          companyId: actor.companyId,
          role: key,
          permission,
          granted: true,
          createdById: actor.userId,
          updatedById: actor.userId,
        },
      });
    }

    this.resolver.invalidate(actor.companyId);
    return this.entryFor(role, actor);
  }

  /** PATCH /roles/{role} — rename / re-describe a custom role. */
  async updateRole(
    roleParam: string,
    dto: UpdateRoleDto,
    actor: AuthUser,
  ): Promise<RoleMatrixEntry> {
    const role = await this.findRole(roleParam);
    if (role.isSystem) {
      throw new ForbiddenException(
        'Built-in roles cannot be renamed (their permissions are still editable)',
      );
    }
    const updated = await this.prisma.role.update({
      where: { id: role.id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description.trim() || null }
          : {}),
        updatedById: actor.userId,
      },
    });
    return this.entryFor(updated, actor);
  }

  /** DELETE /roles/{role} — remove a custom role held by no active user. */
  async deleteRole(roleParam: string, actor: AuthUser): Promise<void> {
    const role = await this.findRole(roleParam);
    if (role.isSystem) {
      throw new ForbiddenException('Built-in roles cannot be deleted');
    }
    const holders = await this.prisma.user.count({
      where: { role: role.key, deletedAt: null },
    });
    if (holders > 0) {
      throw new ConflictException(
        `${holders} user(s) still have this role — reassign them first`,
      );
    }
    // Drop the role's permission overrides, then the registry row.
    const overrides = await this.prisma.rolePermission.findMany({
      where: { role: role.key },
    });
    for (const o of overrides) {
      await this.prisma.rolePermission.delete({ where: { id: o.id } });
    }
    await this.prisma.role.delete({ where: { id: role.id } });
    this.resolver.invalidate(actor.companyId);
  }

  /**
   * PUT /roles/{role}/permissions — persist `desired` as the role's effective
   * set. Writes only the delta from the role's default (empty for a custom
   * role), then invalidates the resolver cache.
   */
  async setPermissions(
    roleParam: string,
    desired: Permission[],
    actor: AuthUser,
  ): Promise<RoleMatrixEntry> {
    const role = await this.assertEditableRole(roleParam);

    const desiredSet = new Set(desired);
    const defaultSet = new Set<Permission>(defaultPermissionsFor(role.key));
    const existing = await this.prisma.rolePermission.findMany({
      where: { role: role.key },
    });
    const existingByPermission = new Map(existing.map((r) => [r.permission, r]));

    for (const permission of ALL_PERMISSIONS) {
      const wantGranted = desiredSet.has(permission);
      const isDefault = defaultSet.has(permission);
      const row = existingByPermission.get(permission);

      if (wantGranted === isDefault) {
        if (row) {
          await this.prisma.rolePermission.delete({ where: { id: row.id } });
        }
        continue;
      }
      if (!row) {
        await this.prisma.rolePermission.create({
          data: {
            companyId: actor.companyId,
            role: role.key,
            permission,
            granted: wantGranted,
            createdById: actor.userId,
            updatedById: actor.userId,
          },
        });
      } else if (row.granted !== wantGranted) {
        await this.prisma.rolePermission.update({
          where: { id: row.id },
          data: { granted: wantGranted, updatedById: actor.userId },
        });
      }
    }

    // Delete override rows for permissions no longer in the catalogue.
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const row of existing) {
      if (!known.has(row.permission)) {
        await this.prisma.rolePermission.delete({ where: { id: row.id } });
      }
    }

    this.resolver.invalidate(actor.companyId);
    return this.entryFor(role, actor);
  }

  /** POST /roles/{role}/reset — discard all overrides, back to the default. */
  async reset(roleParam: string, actor: AuthUser): Promise<RoleMatrixEntry> {
    const role = await this.assertEditableRole(roleParam);
    const existing = await this.prisma.rolePermission.findMany({
      where: { role: role.key },
    });
    for (const row of existing) {
      await this.prisma.rolePermission.delete({ where: { id: row.id } });
    }
    this.resolver.invalidate(actor.companyId);
    return this.entryFor(role, actor);
  }

  // -- internals -------------------------------------------------------------

  private async entryFor(
    role: Role,
    actor: AuthUser,
  ): Promise<RoleMatrixEntry> {
    const [overrides, userCount] = await Promise.all([
      this.resolver.listOverrides(actor.companyId),
      this.prisma.user.count({
        where: { role: role.key, deletedAt: null, active: true },
      }),
    ]);
    return buildEntry(role, overrides, userCount);
  }

  private async userCountsByRole(): Promise<Map<string, number>> {
    const grouped = await this.prisma.user.groupBy({
      by: ['role'],
      where: { deletedAt: null, active: true },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.role, g._count._all]));
  }

  /** Look up a role in the acting company; 404 when it does not exist. */
  private async findRole(roleParam: string): Promise<Role> {
    const role = await this.prisma.role.findFirst({
      where: { key: roleParam },
    });
    if (!role) throw new NotFoundException(`Unknown role: ${roleParam}`);
    return role;
  }

  /** Role must exist and not be the immutable SUPER_ADMIN. */
  private async assertEditableRole(roleParam: string): Promise<Role> {
    const role = await this.findRole(roleParam);
    if (!isRoleEditable(role.key)) {
      throw new ForbiddenException(
        'Super Admin always holds every permission and cannot be edited',
      );
    }
    return role;
  }
}

/** Assemble one role's matrix entry from its registry row + the company's overrides. */
function buildEntry(
  role: Role,
  overrides: readonly PermissionOverride[],
  userCount: number,
): RoleMatrixEntry {
  const key = role.key;
  // Built-in labels/descriptions stay canonical from @triserve/shared; custom
  // roles carry their own from the registry row.
  const label = role.isSystem && isBuiltinRole(key) ? ROLE_LABELS[key] : role.label;
  const description =
    role.isSystem && isBuiltinRole(key)
      ? ROLE_DESCRIPTIONS[key]
      : (role.description ?? '');

  const defaults = [...defaultPermissionsFor(key)];
  const effective = resolveEffectivePermissions(key, overrides);
  const defaultSet = new Set<Permission>(defaults);
  const effectiveSet = new Set(effective);
  const overridden = ALL_PERMISSIONS.filter(
    (p) => defaultSet.has(p) !== effectiveSet.has(p),
  );

  return {
    role: key,
    label,
    description,
    is_system: role.isSystem,
    editable: isRoleEditable(key),
    deletable: !role.isSystem && userCount === 0,
    effective,
    default: defaults,
    overridden,
    user_count: userCount,
  };
}
