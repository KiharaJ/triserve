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
  AdjustStockDto,
  InventoryListQueryDto,
  InventorySettingsDto,
  MovementListQueryDto,
  StockCountDto,
} from './dto/inventory.dto';
import {
  InventoryService,
  type InventoryWire,
  type StockChangeResult,
  type StockMovementWire,
} from './inventory.service';

/**
 * /api/v1/inventory (Task 2.1, DESIGN.md §4.4 / E10) — ledger-backed stock.
 *
 *   GET   /inventory?branch_id=&part_id=&low_stock=&q=&page=  'inventory.read'
 *   GET   /inventory/movements?branch_id=&part_id=&type=&…    'inventory.read'
 *   GET   /inventory/{branch_id}/{part_id}                    'inventory.read'
 *   POST  /inventory/adjust    {branch_id,part_id,delta,…}    'inventory.adjust'
 *   POST  /inventory/count     {branch_id,part_id,counted_qty} 'inventory.count'
 *   POST  /inventory/reconcile {branch_id,part_id}            'inventory.adjust'
 *   PATCH /inventory/settings  {branch_id,part_id,bin,reorder} 'inventory.adjust'
 *
 * Company- AND branch-scoped: a scope='branch' user only sees/moves their
 * branch's stock. Available stock = on_hand − reserved − damaged. Corrections
 * (adjust/count) are approval-gated by value (INVENTORY_ADJUSTMENT); when held,
 * the response carries `held: true` + the PENDING approval and nothing moves.
 */
@Controller('inventory')
@UseGuards(AuthGuard, PermissionsGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @RequirePermissions('inventory.read')
  list(
    @Query() query: InventoryListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<InventoryWire>> {
    return this.inventory.list(query, user);
  }

  @Get('movements')
  @RequirePermissions('inventory.read')
  movements(
    @Query() query: MovementListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<StockMovementWire>> {
    return this.inventory.movements(query, user);
  }

  @Post('adjust')
  @RequirePermissions('inventory.adjust')
  adjust(
    @Body() dto: AdjustStockDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StockChangeResult> {
    return this.inventory.adjust(dto, user);
  }

  @Post('count')
  @RequirePermissions('inventory.count')
  count(
    @Body() dto: StockCountDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StockChangeResult> {
    return this.inventory.count(dto, user);
  }

  @Post('reconcile')
  @RequirePermissions('inventory.adjust')
  reconcile(
    @Body() dto: InventorySettingsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<InventoryWire> {
    return this.inventory.reconcile(dto.branch_id, dto.part_id, user);
  }

  @Patch('settings')
  @RequirePermissions('inventory.adjust')
  settings(
    @Body() dto: InventorySettingsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<InventoryWire> {
    return this.inventory.settings(dto, user);
  }

  @Get(':branchId/:partId')
  @RequirePermissions('inventory.read')
  getOne(
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Param('partId', ParseUUIDPipe) partId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<InventoryWire> {
    return this.inventory.get(branchId, partId, user);
  }
}
