import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
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
import { RolesService } from './roles.service';

/**
 * /api/v1/roles (E17) — the editable role × permission matrix.
 *
 *   GET  /roles                         'user.read'   full matrix
 *   PUT  /roles/{role}/permissions      'user.manage' set a role's grants
 *   POST /roles/{role}/reset            'user.manage' back to defaults
 *
 * Company-scoped; SUPER_ADMIN is immutable (always every permission). Editing
 * a role takes effect on the next request via the resolver cache invalidation.
 */
@Controller('roles')
@UseGuards(AuthGuard, PermissionsGuard)
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('user.read')
  matrix(@CurrentUser() user: AuthUser): Promise<RolesMatrixResponse> {
    return this.roles.matrix(user);
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
