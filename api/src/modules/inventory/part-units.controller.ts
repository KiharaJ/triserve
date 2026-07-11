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
import {
  PartUnitListQueryDto,
  RegisterUnitsDto,
  UpdatePartUnitDto,
} from './dto/part-unit.dto';
import { PartUnitsService, type PartUnitWire } from './part-units.service';

/**
 * Serial/batch unit tracking (Task 2.4, DESIGN.md §4.4 / E11).
 *
 *   POST  /parts/{partId}/units   {serials,…}   'inventory.adjust'  (register)
 *   GET   /part-units?part_id=&status=&serial=…  'inventory.read'
 *   GET   /part-units/{id}                       'inventory.read'
 *   PATCH /part-units/{id}                       'inventory.adjust'
 *
 * Company-scoped (not branch-scoped) so a serial's history is visible group-
 * wide — `serial=` is the recall / "which unit failed" lookup.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class PartUnitsController {
  constructor(private readonly units: PartUnitsService) {}

  @Post('parts/:partId/units')
  @RequirePermissions('inventory.adjust')
  register(
    @Param('partId', ParseUUIDPipe) partId: string,
    @Body() dto: RegisterUnitsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PartUnitWire[]> {
    return this.units.register(partId, dto, user);
  }

  @Get('part-units')
  @RequirePermissions('inventory.read')
  list(
    @Query() query: PartUnitListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<PartUnitWire>> {
    return this.units.list(query, user);
  }

  @Get('part-units/:id')
  @RequirePermissions('inventory.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PartUnitWire> {
    return this.units.get(id, user);
  }

  @Patch('part-units/:id')
  @RequirePermissions('inventory.adjust')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartUnitDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PartUnitWire> {
    return this.units.update(id, dto, user);
  }
}
