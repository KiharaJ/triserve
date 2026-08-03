import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { RoleLimitType } from '@prisma/client';
import type {
  RoleMatrixEntry,
  RolesMatrixResponse,
} from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { UpdateRolePermissionsDto } from './dto/role-permissions.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { UpsertRoleLimitDto } from './dto/role-limit.dto';
import { RoleLimitsService, type RoleLimitWire } from './role-limits.service';
import { RolesService } from './roles.service';

/**
 * /api/v1/roles (E17) — the editable role × permission matrix.
 *
 *   GET    /roles                       'user.read'   full matrix
 *   POST   /roles                       'user.manage' create a custom role
 *   PATCH  /roles/{role}                'user.manage' rename a custom role
 *   DELETE /roles/{role}                'user.manage' delete a custom role
 *   PUT    /roles/{role}/permissions    'user.manage' set a role's grants
 *   POST   /roles/{role}/reset          'user.manage' back to defaults
 *
 * Company-scoped; SUPER_ADMIN is immutable (always every permission). Editing
 * a role takes effect on the next request via the resolver cache invalidation.
 */
@Controller('roles')
@UseGuards(AuthGuard, PermissionsGuard)
export class RolesController {
  constructor(
    private readonly roles: RolesService,
    /** SCMS proposal Module 5 (§6): the financial ceilings beside the grants. */
    private readonly limits: RoleLimitsService,
  ) {}

  // -- SCMS proposal Module 5: financial ceilings ---------------------------
  //
  // Declared BEFORE the ':role' routes: Nest matches in declaration order, so
  // 'limits' and 'my-limits' would otherwise be captured as role names.

  @Get('limits')
  @RequirePermissions('user.read')
  listLimits(@CurrentUser() user: AuthUser): Promise<RoleLimitWire[]> {
    return this.limits.list(user);
  }

  /**
   * The CALLER's own ceilings, so the UI can grey out a discount field rather
   * than let someone type a number and be refused. Gated on nothing beyond
   * being signed in: it reveals only what applies to you.
   */
  @Get('my-limits')
  myLimits(@CurrentUser() user: AuthUser): Promise<RoleLimitWire[]> {
    return this.limits.forCurrentUser(user);
  }

  @Get()
  @RequirePermissions('user.read')
  matrix(@CurrentUser() user: AuthUser): Promise<RolesMatrixResponse> {
    return this.roles.matrix(user);
  }

  @Post()
  @RequirePermissions('user.manage')
  create(
    @Body() dto: CreateRoleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RoleMatrixEntry> {
    return this.roles.createRole(dto, user);
  }

  @Patch(':role')
  @RequirePermissions('user.manage')
  updateRole(
    @Param('role') role: string,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RoleMatrixEntry> {
    return this.roles.updateRole(role, dto, user);
  }

  @Delete(':role')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('user.manage')
  deleteRole(
    @Param('role') role: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.roles.deleteRole(role, user);
  }

  @Put(':role/permissions')
  @RequirePermissions('user.manage')
  setPermissions(
    @Param('role') role: string,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RoleMatrixEntry> {
    return this.roles.setPermissions(role, dto.permissions, user);
  }

  @Put(':role/limits')
  @RequirePermissions('user.manage')
  setLimit(
    @Param('role') role: string,
    @Body() dto: UpsertRoleLimitDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RoleLimitWire> {
    return this.limits.upsert(
      role,
      dto.type,
      {
        max_amount: dto.max_amount,
        currency: dto.currency,
        max_percent: dto.max_percent,
        enabled: dto.enabled,
      },
      user,
    );
  }

  @Delete(':role/limits/:type')
  @RequirePermissions('user.manage')
  removeLimit(
    @Param('role') role: string,
    @Param('type') type: RoleLimitType,
    @CurrentUser() user: AuthUser,
  ): Promise<{ role: string; type: RoleLimitType }> {
    return this.limits.remove(role, type, user);
  }

  @Post(':role/reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user.manage')
  reset(
    @Param('role') role: string,
    @CurrentUser() user: AuthUser,
  ): Promise<RoleMatrixEntry> {
    return this.roles.reset(role, user);
  }
}
