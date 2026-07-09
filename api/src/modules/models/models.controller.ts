import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CreateModelDto, ModelListQueryDto } from './dto/model.dto';
import { ModelsService, type ModelWire } from './models.service';

/**
 * /api/v1/models (Task 1.1, DESIGN.md §4.2) — the device-model lookup.
 *
 *   GET  /models?q=&category=&active=&page=&page_size=  'model.read'
 *   POST /models                                        'model.manage'
 *
 * POST is admin/manager-gated: 'model.manage' is held by SUPER_ADMIN and
 * BRANCH_MANAGER only (default matrix). Company-level config, like fault
 * codes.
 */
@Controller('models')
@UseGuards(AuthGuard, PermissionsGuard)
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  @RequirePermissions('model.read')
  list(
    @Query() query: ModelListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<ModelWire>> {
    return this.models.list(query, user);
  }

  @Post()
  @RequirePermissions('model.manage')
  create(
    @Body() dto: CreateModelDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ModelWire> {
    return this.models.create(dto, user);
  }
}
