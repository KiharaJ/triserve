import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALL_PERMISSIONS } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../../modules/auth/auth.types';
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
  const guard = new PermissionsGuard(new Reflector());
  const proto = DummyController.prototype;

  it('denies TECHNICIAN user.manage (403 FORBIDDEN)', () => {
    const ctx = makeContext(
      proto.manageUsers,
      makeUser({ role: 'TECHNICIAN' }),
    );
    let caught: unknown;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
    expect((caught as ForbiddenException).message).toContain('user.manage');
  });

  it('allows TECHNICIAN job.transition (in their role map)', () => {
    const ctx = makeContext(
      proto.transitionJob,
      makeUser({ role: 'TECHNICIAN' }),
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows SUPER_ADMIN everything', () => {
    const admin = makeUser({ role: 'SUPER_ADMIN', scope: 'group' });
    expect(guard.canActivate(makeContext(proto.manageUsers, admin))).toBe(true);
    expect(guard.canActivate(makeContext(proto.transitionJob, admin))).toBe(
      true,
    );
    expect(guard.canActivate(makeContext(proto.approveAndAdjust, admin))).toBe(
      true,
    );
  });

  it('ANDs multiple permissions — STOREKEEPER lacks po.approve', () => {
    // STOREKEEPER has inventory.adjust but NOT po.approve → still 403.
    const ctx = makeContext(
      proto.approveAndAdjust,
      makeUser({ role: 'STOREKEEPER' }),
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(/po\.approve/);
  });

  it('allows BRANCH_MANAGER po.approve + inventory.adjust', () => {
    const ctx = makeContext(
      proto.approveAndAdjust,
      makeUser({ role: 'BRANCH_MANAGER' }),
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies SERVICE_ADVISOR accounting-only actions via role map', () => {
    const advisor = makeUser({ role: 'SERVICE_ADVISOR' });
    expect(() =>
      guard.canActivate(makeContext(proto.manageUsers, advisor)),
    ).toThrow(ForbiddenException);
  });

  it('passes routes without @RequirePermissions metadata untouched', () => {
    expect(guard.canActivate(makeContext(proto.noMetadata, undefined))).toBe(
      true,
    );
  });

  it('fails closed when metadata exists but no user was attached', () => {
    expect(() =>
      guard.canActivate(makeContext(proto.manageUsers, undefined)),
    ).toThrow(ForbiddenException);
  });

  it('sanity: the permission vocabulary is non-empty and unique', () => {
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(30);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});
