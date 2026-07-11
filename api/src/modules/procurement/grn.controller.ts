import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import { GrnListQueryDto, ReceiveGoodsDto } from './dto/grn.dto';
import { GrnService, type GrnWire } from './grn.service';

/**
 * Goods received notes (Task 2.7, DESIGN.md §4.4b).
 *
 *   POST /purchase-orders/{poId}/receipts   'grn.receive'   (posts stock)
 *   GET  /goods-received-notes?po_id=&…      'po.read'
 *   GET  /goods-received-notes/{id}          'po.read'
 *
 * Posting a GRN moves stock (RECEIPT movements) and advances the PO. Company-
 * AND branch-scoped.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class GrnController {
  constructor(private readonly grn: GrnService) {}

  @Post('purchase-orders/:poId/receipts')
  @RequirePermissions('grn.receive')
  receive(
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: ReceiveGoodsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GrnWire> {
    return this.grn.receive(poId, dto, user);
  }

  @Get('goods-received-notes')
  @RequirePermissions('po.read')
  list(
    @Query() query: GrnListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<GrnWire>> {
    return this.grn.list(query, user);
  }

  @Get('goods-received-notes/:id')
  @RequirePermissions('po.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<GrnWire> {
    return this.grn.get(id, user);
  }
}
