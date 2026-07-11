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
import { PaymentListQueryDto, RecordPaymentDto } from './dto/payment.dto';
import {
  PaymentsService,
  type PaymentWire,
  type RecordPaymentResult,
} from './payments.service';

/**
 * Payments (Task 3.2, DESIGN.md §4.6).
 *
 *   POST /invoices/{id}/payments  {method,amount,…}   'payment.capture'
 *   GET  /invoices/{id}/payments                       'invoice.read'
 *   GET  /payments?invoice_id=&method=&branch_id=&…    'invoice.read'
 *
 * Recording a payment advances the invoice (deposit → balance → paid).
 * Company- AND branch-scoped.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('invoices/:invoiceId/payments')
  @RequirePermissions('payment.capture')
  record(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RecordPaymentResult> {
    return this.payments.record(invoiceId, dto, user);
  }

  @Get('invoices/:invoiceId/payments')
  @RequirePermissions('invoice.read')
  listForInvoice(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentWire[]> {
    return this.payments.listForInvoice(invoiceId, user);
  }

  @Get('payments')
  @RequirePermissions('invoice.read')
  list(
    @Query() query: PaymentListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<PaymentWire>> {
    return this.payments.list(query, user);
  }
}
