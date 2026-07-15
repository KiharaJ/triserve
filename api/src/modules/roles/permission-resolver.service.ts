import { Injectable } from '@nestjs/common';
import {
  ALL_PERMISSIONS,
  resolveEffectivePermissions,
  type Permission,
  type PermissionOverride,
} from '@triserve/shared';
import { PrismaService } from '../../prisma/prisma.service';

interface CacheEntry {
  /** The company's raw overrides (deltas). */
  overrides: PermissionOverride[];
  /** Lazily-memoised effective set per role key (built-in OR custom). */
  roleSets: Map<string, Set<Permission>>;
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

  /** True when `role` (built-in or custom key) holds `permission`. */
  async has(
    companyId: string,
    role: string,
    permission: Permission,
  ): Promise<boolean> {
    if (role === 'SUPER_ADMIN') return true;
    const set = await this.roleSet(companyId, role);
    return set.has(permission);
  }

  /** The effective permission list for one role key (catalogue order). */
  async effectiveForRole(
    companyId: string,
    role: string,
  ): Promise<Permission[]> {
    if (role === 'SUPER_ADMIN') return [...ALL_PERMISSIONS];
    const set = await this.roleSet(companyId, role);
    return ALL_PERMISSIONS.filter((p) => set.has(p));
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
      role: r.role,
      permission: r.permission as Permission,
      granted: r.granted,
    }));
  }

  /** Drop a company's cached overrides so the next resolve reflects fresh edits. */
  invalidate(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** Effective permission set for one role key (cached per company + memoised). */
  private async roleSet(
    companyId: string,
    role: string,
  ): Promise<Set<Permission>> {
    const entry = await this.entry(companyId);
    let set = entry.roleSets.get(role);
    if (!set) {
      // Works for any key: a custom role has an empty default, so its grants
      // come entirely from `granted` overrides.
      set = new Set(resolveEffectivePermissions(role, entry.overrides));
      entry.roleSets.set(role, set);
    }
    return set;
  }

  /** The company's cached override set (loaded once per TTL window). */
  private async entry(companyId: string): Promise<CacheEntry> {
    const cached = this.cache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const overrides = await this.listOverrides(companyId);
    const entry: CacheEntry = {
      overrides,
      roleSets: new Map(),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.cache.set(companyId, entry);
    return entry;
  }
}
