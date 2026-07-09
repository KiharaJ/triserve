import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../../modules/auth/auth.types';

/**
 * Branch-scope gate (Task 0.3, DESIGN.md §3): scope='group' users may act
 * on any branch of their company; scope='branch' users only on their home
 * branch. Call it in any service/controller that receives an explicit
 * branchId (transfers, reports, branch admin, …) BEFORE acting on it.
 *
 * Company membership of `branchId` is enforced separately by the Prisma
 * company-scope extension — this helper only checks the branch dimension.
 *
 * Throws 403 → `{ error: { code: 'FORBIDDEN', ... } }` via the global filter.
 */
export function assertBranchAccess(
  user: Pick<AuthUser, 'scope' | 'homeBranchId'>,
  branchId: string,
): void {
  if (user.scope === 'group') return;
  if (user.homeBranchId === branchId) return;
  throw new ForbiddenException('You do not have access to this branch');
}
