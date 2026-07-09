import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { roleHasPermission, type Permission } from '@triserve/shared';
import type { Request } from 'express';
import type { AuthUser } from '../../modules/auth/auth.types';
import { PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)` metadata against the acting user's
 * role (Task 0.3 / E18). Must run AFTER AuthGuard (list AuthGuard first in
 * `@UseGuards`). SUPER_ADMIN passes everything. Failures surface through
 * the global filter as `{ error: { code: 'FORBIDDEN', ... } }`.
 *
 * EXTENSION POINT (E17): permissions currently resolve from the static
 * ROLE_PERMISSIONS default matrix in @triserve/shared. When the per-company
 * editable matrix lands, swap `roleHasPermission` for an injected resolver
 * (e.g. `PermissionResolver.has(user, permission)`) that reads DB overrides
 * and falls back to the shared defaults — this guard's contract stays.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      PERMISSIONS_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    // AuthGuard should have run first; fail closed if it did not.
    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const missing = required.filter((p) => !roleHasPermission(user.role, p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
