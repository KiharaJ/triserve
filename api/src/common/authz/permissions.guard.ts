import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Permission } from '@triserve/shared';
import type { Request } from 'express';
import type { AuthUser } from '../../modules/auth/auth.types';
import { PermissionResolverService } from '../../modules/roles/permission-resolver.service';
import { PERMISSIONS_METADATA_KEY } from './require-permissions.decorator';

/**
 * Enforces `@RequirePermissions(...)` metadata against the acting user's
 * EFFECTIVE permissions (Task 0.3 / E18 / E17). Must run AFTER AuthGuard
 * (list AuthGuard first in `@UseGuards`). SUPER_ADMIN passes everything.
 * Failures surface through the global filter as
 * `{ error: { code: 'FORBIDDEN', ... } }`.
 *
 * Permissions resolve through {@link PermissionResolverService}, which layers
 * the company's persisted overrides (`role_permissions`) on top of the static
 * ROLE_PERMISSIONS defaults in @triserve/shared — so an admin's matrix edits
 * are enforced here on the very next request, not just reflected in the UI.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    const held = await Promise.all(
      required.map((p) => this.resolver.has(user.companyId, user.role, p)),
    );
    const missing = required.filter((_p, i) => !held[i]);
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
