import { ForbiddenException } from '@nestjs/common';
import { assertBranchAccess } from './branch-access';

describe('assertBranchAccess', () => {
  const branchX = 'branch-x-id';
  const branchY = 'branch-y-id';

  it('throws 403 when a branch-scoped user targets another branch', () => {
    const user = { scope: 'branch' as const, homeBranchId: branchX };
    let caught: unknown;
    try {
      assertBranchAccess(user, branchY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
  });

  it('passes when a branch-scoped user targets their home branch', () => {
    const user = { scope: 'branch' as const, homeBranchId: branchX };
    expect(() => assertBranchAccess(user, branchX)).not.toThrow();
  });

  it('passes group-scoped users for any branch', () => {
    const user = { scope: 'group' as const, homeBranchId: null };
    expect(() => assertBranchAccess(user, branchX)).not.toThrow();
    expect(() => assertBranchAccess(user, branchY)).not.toThrow();
  });

  it('throws for a branch-scoped user with no home branch', () => {
    const user = { scope: 'branch' as const, homeBranchId: null };
    expect(() => assertBranchAccess(user, branchX)).toThrow(ForbiddenException);
  });
});
