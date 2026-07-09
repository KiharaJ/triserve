import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CreateUserDto, UpdateUserDto, UserListQueryDto } from './dto/user.dto';
import { UsersService, type UserWire } from './users.service';

/**
 * /api/v1/users (Task 0.7, DESIGN.md §3/§4.1) — user admin.
 *
 *   GET   /users?role=&branch_id=&active=&q=&page=   'user.read'
 *   GET   /users/{id}                                'user.read'
 *   POST  /users                                     'user.manage'
 *   PATCH /users/{id}                                'user.manage'
 *   POST  /users/{id}/activate | /deactivate         'user.manage'
 *
 * Company-scoped; password hashes and TOTP secrets never leave the API.
 * Activate/deactivate replaces deletion (soft-delete convention).
 */
@Controller('users')
@UseGuards(AuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user.read')
  list(
    @Query() query: UserListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<UserWire>> {
    return this.users.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('user.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<UserWire> {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('user.manage')
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AuthUser,
  ): Promise<UserWire> {
    return this.users.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('user.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ): Promise<UserWire> {
    return this.users.update(id, dto, user);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user.manage')
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<UserWire> {
    return this.users.setActive(id, true, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user.manage')
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<UserWire> {
    return this.users.setActive(id, false, user);
  }
}
