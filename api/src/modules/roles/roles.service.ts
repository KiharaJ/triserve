import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  isRoleEditable,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  resolveEffectivePermissions,
  USER_ROLES,
  type Permission,
  type PermissionOverride,
  type RoleMatrixEntry,
  type RoleName,
  type RolesMatrixResponse,
} from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Roles admin (E17) — reads and edits the per-company role × permission
 * matrix. Enforcement lives in {@link PermissionResolverService}; this service
 * only reconciles the persisted DELTA (`role_permissions`) against the static
 * defaults and keeps the resolver's cache fresh.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolverService,
  ) {}

  /** GET /roles — the full matrix for the acting company. */
  async matrix(actor: AuthUser): Promise<RolesMatrixResponse> {
    const [overrides, counts] = await Promise.all([
      this.resolver.listOverrides(actor.companyId),
      this.userCountsByRole(),
    ]);
    return {
      roles: USER_ROLES.map((role) =>
        buildEntry(role, overrides, counts.get(role) ?? 0),
      ),
    };
  }

  /**
   * PUT /roles/{role}/permissions — persist `desired` as the role's effective
   * set. Writes only the delta from the default matrix (create/update/delete
   * override rows), then invalidates the resolver cache so the change is live
   * on the next request.
   */
  async setPermissions(
    roleParam: string,
    desired: Permission[],
    actor: AuthUser,
  ): Promise<RoleMatrixEntry> {
    const role = this.assertEditableRole(roleParam);

    const desiredSet = new Set(desired);
    const defaultSet = new Set<Permission>(ROLE_PERMISSIONS[role]);
    const existing = await this.prisma.rolePermission.findMany({
      where: { role },
    });
    const existingByPermission = new Map(
      existing.map((r) => [r.permission, r]),
    );

    for (const permission of ALL_PERMISSIONS) {
      const wantGranted = desiredSet.has(permission);
      const isDefault = defaultSet.has(permission);
      const row = existingByPermission.get(permission);

      if (wantGranted === isDefault) {
        // Matches the default → no override needed; drop any stale row.
        if (row) {
          await this.prisma.rolePermission.delete({ where: { id: row.id } });
        }
        continue;
      }
      // Deviates from the default → an override row must exist with this grant.
      if (!row) {
        await this.prisma.rolePermission.create({
          data: {
            companyId: actor.companyId,
            role,
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

    // Delete any override rows for permissions no longer in the catalogue.
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
    const role = this.assertEditableRole(roleParam);
    const existing = await this.prisma.rolePermission.findMany({
      where: { role },
    });
    for (const row of existing) {
      await this.prisma.rolePermission.delete({ where: { id: row.id } });
    }
    this.resolver.invalidate(actor.companyId);
    return this.entryFor(role, actor);
  }

  // -- internals -------------------------------------------------------------

  private async entryFor(
    role: RoleName,
    actor: AuthUser,
  ): Promise<RoleMatrixEntry> {
    const [overrides, counts] = await Promise.all([
      this.resolver.listOverrides(actor.companyId),
      this.userCountsByRole(),
    ]);
    return buildEntry(role, overrides, counts.get(role) ?? 0);
  }

  private async userCountsByRole(): Promise<Map<RoleName, number>> {
    const grouped = await this.prisma.user.groupBy({
      by: ['role'],
      where: { deletedAt: null, active: true },
      _count: { _all: true },
    });
    return new Map(
      grouped.map((g) => [g.role as RoleName, g._count._all]),
    );
  }

  /** Validate the URL role param and refuse to edit the immutable SUPER_ADMIN. */
  private assertEditableRole(roleParam: string): RoleName {
    if (!USER_ROLES.includes(roleParam as RoleName)) {
      throw new BadRequestException(`Unknown role: ${roleParam}`);
    }
    const role = roleParam as RoleName;
    if (!isRoleEditable(role)) {
      throw new ForbiddenException(
        `${ROLE_LABELS[role]} always holds every permission and cannot be edited`,
      );
    }
    return role;
  }
}

/** Assemble one role's matrix entry from the company's overrides. */
function buildEntry(
  role: RoleName,
  overrides: readonly PermissionOverride[],
  userCount: number,
): RoleMatrixEntry {
  const defaults = [...ROLE_PERMISSIONS[role]];
  const effective =
    role === 'SUPER_ADMIN'
      ? [...ALL_PERMISSIONS]
      : resolveEffectivePermissions(role, overrides);
  const defaultSet = new Set<Permission>(defaults);
  const effectiveSet = new Set(effective);
  const overridden = ALL_PERMISSIONS.filter(
    (p) => defaultSet.has(p) !== effectiveSet.has(p),
  );
  return {
    role,
    label: ROLE_LABELS[role],
    description: ROLE_DESCRIPTIONS[role],
    editable: isRoleEditable(role),
    effective,
    default: role === 'SUPER_ADMIN' ? [...ALL_PERMISSIONS] : defaults,
    overridden,
    user_count: userCount,
  };
}
