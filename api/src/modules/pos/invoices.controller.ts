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
  CreateInvoiceDto,
  InvoiceListQueryDto,
  UpdateInvoiceDto,
  VoidInvoiceDto,
} from './dto/invoice.dto';
import {
  InvoicesService,
  type InvoiceWire,
  type VoidResult,
} from './invoices.service';

/**
 * /api/v1/invoices (Task 3.1, DESIGN.md §4.6) — the sell side (OW sales).
 *
 *   GET   /invoices?status=&type=&branch_id=&customer_id=&job_id=&q=  'invoice.read'
 *   GET   /invoices/{id}                                             'invoice.read'
 *   POST  /invoices                                                  'invoice.create'
 *   PATCH /invoices/{id}                                (DRAFT)      'invoice.create'
 *   POST  /invoices/{id}/void   {reason}                             'invoice.void'
 *
 * Company- AND branch-scoped. A void is approval-gated (INVOICE_VOID) — when
 * held, the response carries `held: true` + the PENDING approval.
 */
@Controller('invoices')
@UseGuards(AuthGuard, PermissionsGuard)
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermissions('invoice.read')
  list(
    @Query() query: InvoiceListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<InvoiceWire>> {
    return this.invoices.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('invoice.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<InvoiceWire> {
    return this.invoices.get(id, user);
  }

  @Post()
  @RequirePermissions('invoice.create')
  create(
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<InvoiceWire> {
    return this.invoices.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('invoice.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInvoiceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<InvoiceWire> {
    return this.invoices.update(id, dto, user);
  }

  @Post(':id/void')
  @RequirePermissions('invoice.void')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<VoidResult> {
    return this.invoices.void(id, dto.reason, user);
  }
}
