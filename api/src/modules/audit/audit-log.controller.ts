import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { AuditService, type AuditLogEntry } from './audit.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';

/**
 * GET /api/v1/audit-log (Task 0.4, DESIGN.md §7).
 *
 * Read-only BY DESIGN — the audit trail is append-only, so this controller
 * will never grow POST/PATCH/DELETE handlers. Gated by 'audit.read' from
 * the shared permission matrix (SUPER_ADMIN, BRANCH_MANAGER, ACCOUNTANT);
 * rows are company-scoped to the caller.
 */
@Controller('audit-log')
@UseGuards(AuthGuard, PermissionsGuard)
export class AuditLogController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(
    @Query() query: AuditLogQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<AuditLogEntry>> {
    return this.auditService.list(query, user);
  }
}
