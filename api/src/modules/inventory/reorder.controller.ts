import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { ReorderService, type ReorderSuggestions } from './reorder.service';

class ReorderQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;
}

/**
 * /api/v1/reorder-suggestions (Task 2.9, DESIGN.md §4.4b).
 *
 *   GET /reorder-suggestions?branch_id=   'po.read'
 *
 * Parts at/below reorder level for a branch, grouped by preferred supplier with
 * a suggested order quantity — the raw material for a one-click PO (the client
 * posts each group to /purchase-orders). Branch users default to their branch.
 */
@Controller('reorder-suggestions')
@UseGuards(AuthGuard, PermissionsGuard)
export class ReorderController {
  constructor(private readonly reorder: ReorderService) {}

  @Get()
  @RequirePermissions('po.read')
  suggestions(
    @Query() query: ReorderQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ReorderSuggestions> {
    return this.reorder.suggestions(query.branch_id, user);
  }
}
