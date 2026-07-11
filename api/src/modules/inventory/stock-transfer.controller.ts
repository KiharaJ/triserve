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
import { CreateTransferDto, TransferListQueryDto } from './dto/transfer.dto';
import {
  StockTransferService,
  type TransferDispatchResult,
  type TransferWire,
} from './stock-transfer.service';

/**
 * /api/v1/transfers (Task 2.3, DESIGN.md §4.4) — inter-branch stock transfers.
 *
 *   GET  /transfers?status=&branch_id=&q=&page=   'inventory.read'
 *   GET  /transfers/{id}                          'inventory.read'
 *   POST /transfers                               'inventory.transfer'
 *   POST /transfers/{id}/dispatch                 'inventory.transfer'
 *   POST /transfers/{id}/receive                  'inventory.transfer'
 *   POST /transfers/{id}/cancel                   'inventory.transfer'
 *
 * Company-scoped; branch users only see/act on transfers touching their
 * branch. Dispatch is approval-gated by value (STOCK_TRANSFER) — a held
 * dispatch returns held:true and moves nothing.
 */
@Controller('transfers')
@UseGuards(AuthGuard, PermissionsGuard)
export class StockTransferController {
  constructor(private readonly transfers: StockTransferService) {}

  @Get()
  @RequirePermissions('inventory.read')
  list(
    @Query() query: TransferListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<TransferWire>> {
    return this.transfers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('inventory.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TransferWire> {
    return this.transfers.get(id, user);
  }

  @Post()
  @RequirePermissions('inventory.transfer')
  create(
    @Body() dto: CreateTransferDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransferWire> {
    return this.transfers.create(dto, user);
  }

  @Post(':id/dispatch')
  @RequirePermissions('inventory.transfer')
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TransferDispatchResult> {
    return this.transfers.dispatch(id, user);
  }

  @Post(':id/receive')
  @RequirePermissions('inventory.transfer')
  receive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TransferWire> {
    return this.transfers.receive(id, user);
  }

  @Post(':id/cancel')
  @RequirePermissions('inventory.transfer')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<TransferWire> {
    return this.transfers.cancel(id, user);
  }
}
