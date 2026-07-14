import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ALL_PERMISSIONS,
  roleHasPermission,
  type Permission,
  type RoleName,
} from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../../modules/auth/auth.types';
import type { PermissionResolverService } from '../../modules/roles/permission-resolver.service';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermissions } from './require-permissions.decorator';

/**
 * Dummy controller whose handlers carry real @RequirePermissions metadata.
 * (`this: void` because the tests pass the methods around unbound.)
 */
class DummyController {
  @RequirePermissions('user.manage')
  manageUsers(this: void): void {}

  @RequirePermissions('job.transition')
  transitionJob(this: void): void {}

  @RequirePermissions('po.approve', 'inventory.adjust')
  approveAndAdjust(this: void): void {}

  noMetadata(this: void): void {}
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: randomUUID(),
    sessionId: randomUUID(),
    companyId: randomUUID(),
    role: 'TECHNICIAN',
    scope: 'branch',
    homeBranchId: randomUUID(),
    ...overrides,
  };
}

function makeContext(
  handler: (...args: unknown[]) => unknown,
  user?: AuthUser,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DummyController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  // Resolver backed by the STATIC defaults — these tests assert the default
  // matrix enforcement; per-company overrides are covered by the resolver's
  // own tests. `has` mirrors what resolveEffectivePermissions yields for an
  // override-free company.
  const resolver = {
    has: (_companyId: string, role: RoleName, permission: Permission) =>
      Promise.resolve(roleHasPermission(role, permission)),
  } as unknown as PermissionResolverService;
  const guard = new PermissionsGuard(new Reflector(), resolver);
  const proto = DummyController.prototype;

  it('denies TECHNICIAN user.manage (403 FORBIDDEN)', async () => {
    const ctx = makeContext(
      proto.manageUsers,
      makeUser({ role: 'TECHNICIAN' }),
    );
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
    expect((caught as ForbiddenException).message).toContain('user.manage');
  });

  it('allows TECHNICIAN job.transition (in their role map)', async () => {
    const ctx = makeContext(
      proto.transitionJob,
      makeUser({ role: 'TECHNICIAN' }),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows SUPER_ADMIN everything', async () => {
    const admin = makeUser({ role: 'SUPER_ADMIN', scope: 'group' });
    await expect(
      guard.canActivate(makeContext(proto.manageUsers, admin)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext(proto.transitionJob, admin)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeContext(proto.approveAndAdjust, admin)),
    ).resolves.toBe(true);
  });

  it('ANDs multiple permissions — STOREKEEPER lacks po.approve', async () => {
    // STOREKEEPER has inventory.adjust but NOT po.approve → still 403.
    const ctx = makeContext(
      proto.approveAndAdjust,
      makeUser({ role: 'STOREKEEPER' }),
    );
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctx)).rejects.toThrow(/po\.approve/);
  });

  it('allows BRANCH_MANAGER po.approve + inventory.adjust', async () => {
    const ctx = makeContext(
      proto.approveAndAdjust,
      makeUser({ role: 'BRANCH_MANAGER' }),
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('denies SERVICE_ADVISOR accounting-only actions via role map', async () => {
    const advisor = makeUser({ role: 'SERVICE_ADVISOR' });
    await expect(
      guard.canActivate(makeContext(proto.manageUsers, advisor)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('passes routes without @RequirePermissions metadata untouched', async () => {
    await expect(
      guard.canActivate(makeContext(proto.noMetadata, undefined)),
    ).resolves.toBe(true);
  });

  it('fails closed when metadata exists but no user was attached', async () => {
    await expect(
      guard.canActivate(makeContext(proto.manageUsers, undefined)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('sanity: the permission vocabulary is non-empty and unique', () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(30);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});
