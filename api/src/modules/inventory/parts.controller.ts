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
import { CreatePartDto, PartListQueryDto, UpdatePartDto } from './dto/part.dto';
import { PartsService, type PartWire } from './parts.service';

/**
 * /api/v1/parts (Task 2.1, DESIGN.md §4.4) — the spare-parts catalogue.
 *
 *   GET   /parts?category=&active=&q=&page=   'part.read'
 *   GET   /parts/{id}                         'part.read'
 *   POST  /parts                              'part.manage'
 *   PATCH /parts/{id}                         'part.manage'
 *
 * Company-scoped, company-level config (like models) — not branch-scoped.
 * No DELETE: parts carry stock/movement history; deactivate via `active`.
 */
@Controller('parts')
@UseGuards(AuthGuard, PermissionsGuard)
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  @Get()
  @RequirePermissions('part.read')
  list(
    @Query() query: PartListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<PartWire>> {
    return this.parts.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('part.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PartWire> {
    return this.parts.get(id, user);
  }

  @Post()
  @RequirePermissions('part.manage')
  create(
    @Body() dto: CreatePartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PartWire> {
    return this.parts.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('part.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PartWire> {
    return this.parts.update(id, dto, user);
  }
}
