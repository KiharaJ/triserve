import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@triserve/shared';

export const PERMISSIONS_METADATA_KEY = 'triserve:required-permissions';

/**
 * Declares the permission(s) an endpoint requires (Task 0.3 / E18):
 *
 *   @UseGuards(AuthGuard, PermissionsGuard)
 *   @RequirePermissions('job.transition')
 *   @Post(':id/transition')
 *   transition(...) { ... }
 *
 * Enforced by {@link PermissionsGuard}; multiple permissions are ANDed.
 * Also valid on a controller class (handler metadata overrides class).
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_METADATA_KEY, permissions);
