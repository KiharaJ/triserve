import {
  Body,
  Controller,
  Get,
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
import { BranchesService, type BranchWire } from './branches.service';
import {
  BranchListQueryDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

/**
 * /api/v1/branches (Task 0.7, DESIGN.md §4.1).
 *
 *   GET   /branches?q=&active=&page=&page_size=   'config.read'
 *   GET   /branches/{id}                          'config.read'
 *   POST  /branches                               'config.manage'
 *   PATCH /branches/{id}                          'config.manage'
 *
 * No DELETE: branches are deactivated (active=false), never removed —
 * jobs/ledger history must keep resolving. Company-scoped to the caller.
 */
@Controller('branches')
@UseGuards(AuthGuard, PermissionsGuard)
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: BranchListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<BranchWire>> {
    return this.branches.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('config.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BranchWire> {
    return this.branches.get(id);
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreateBranchDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BranchWire> {
    return this.branches.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BranchWire> {
    return this.branches.update(id, dto, user);
  }
}
