import { Injectable } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  resolveEffectivePermissions,
  USER_ROLES,
  type Permission,
  type PermissionOverride,
  type RoleName,
} from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';

type Matrix = Record<RoleName, Set<Permission>>;

interface CacheEntry {
  matrix: Matrix;
  expiresAt: number;
}

/**
 * Resolves the EFFECTIVE role × permission matrix for a company (E17).
 *
 * The static defaults live in @triserve/shared (`ROLE_PERMISSIONS`); this
 * service layers each company's persisted overrides (`role_permissions`) on
 * top via {@link resolveEffectivePermissions} and answers the one question
 * the {@link PermissionsGuard} asks on every request: does `role` hold
 * `permission` for this company?
 *
 * A short-lived per-company cache keeps that hot path off the database; every
 * write through {@link RolesService} calls {@link invalidate} so an edit takes
 * effect on the very next request. SUPER_ADMIN always holds every permission
 * and never touches the cache or the DB.
 *
 * This provider is company-agnostic: callers pass the companyId explicitly, so
 * it works both inside a request (the guard) and during login (before a
 * request-scoped user context exists).
 */
@Injectable()
export class PermissionResolverService {
  /** Backstop TTL; explicit invalidation is the primary freshness mechanism. */
  private readonly ttlMs = 30_000;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** True when `role` holds `permission` for `companyId`. */
  async has(
    companyId: string,
    role: RoleName,
    permission: Permission,
  ): Promise<boolean> {
    if (role === 'SUPER_ADMIN') return true;
    const matrix = await this.matrix(companyId);
    return matrix[role]?.has(permission) ?? false;
  }

  /** The effective permission list for one role (catalogue order). */
  async effectiveForRole(
    companyId: string,
    role: RoleName,
  ): Promise<Permission[]> {
    if (role === 'SUPER_ADMIN') return [...ALL_PERMISSIONS];
    const matrix = await this.matrix(companyId);
    return ALL_PERMISSIONS.filter((p) => matrix[role].has(p));
  }

  /**
   * The company's raw overrides (deltas from the default matrix). Used by the
   * roles admin endpoint to show which permissions were changed. Reads
   * straight through — the callers here are cold admin screens, not the hot
   * enforcement path.
   */
  async listOverrides(companyId: string): Promise<PermissionOverride[]> {
    const rows = await this.prisma.rolePermission.findMany({
      where: { companyId },
    });
    return rows.map((r) => ({
      role: r.role as RoleName,
      permission: r.permission as Permission,
      granted: r.granted,
    }));
  }

  /** Drop a company's cached matrix so the next resolve reflects fresh edits. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** Effective matrix for a company (cached), as membership sets. */
  private async matrix(companyId: string): Promise<Matrix> {
    const cached = this.cache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) return cached.matrix;

    const overrides = await this.listOverrides(companyId);
    const matrix = {} as Matrix;
    for (const role of USER_ROLES) {
      matrix[role] = new Set(resolveEffectivePermissions(role, overrides));
    }
    this.cache.set(companyId, { matrix, expiresAt: Date.now() + this.ttlMs });
    return matrix;
  }
}
