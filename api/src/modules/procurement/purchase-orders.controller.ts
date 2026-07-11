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
  CreatePurchaseOrderDto,
  PurchaseOrderListQueryDto,
  UpdatePurchaseOrderDto,
} from './dto/purchase-order.dto';
import {
  PurchaseOrdersService,
  type PurchaseOrderWire,
} from './purchase-orders.service';

/**
 * /api/v1/purchase-orders (Task 2.6, DESIGN.md §4.4b).
 *
 *   GET   /purchase-orders?status=&supplier_id=&branch_id=&q=  'po.read'
 *   GET   /purchase-orders/{id}                                'po.read'
 *   POST  /purchase-orders                                     'po.create'
 *   PATCH /purchase-orders/{id}                     (DRAFT)    'po.create'
 *   POST  /purchase-orders/{id}/submit                         'po.create'
 *   POST  /purchase-orders/{id}/approve                        'po.approve'
 *   POST  /purchase-orders/{id}/order                          'po.create'
 *   POST  /purchase-orders/{id}/cancel                         'po.create'
 *
 * Company- AND branch-scoped (branch_id = destination). Large orders (≥ the
 * PURCHASE_ORDER threshold) must be APPROVED before they can be ordered.
 */
@Controller('purchase-orders')
@UseGuards(AuthGuard, PermissionsGuard)
export class PurchaseOrdersController {
  constructor(private readonly pos: PurchaseOrdersService) {}

  @Get()
  @RequirePermissions('po.read')
  list(
    @Query() query: PurchaseOrderListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<PurchaseOrderWire>> {
    return this.pos.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('po.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.get(id, user);
  }

  @Post()
  @RequirePermissions('po.create')
  create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('po.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.update(id, dto, user);
  }

  @Post(':id/submit')
  @RequirePermissions('po.create')
  submit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.submit(id, user);
  }

  @Post(':id/approve')
  @RequirePermissions('po.approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.approve(id, user);
  }

  @Post(':id/order')
  @RequirePermissions('po.create')
  order(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.order(id, user);
  }

  @Post(':id/cancel')
  @RequirePermissions('po.create')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PurchaseOrderWire> {
    return this.pos.cancel(id, user);
  }
}
