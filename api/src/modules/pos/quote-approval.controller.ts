import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  QuoteApprovalService,
  type PublicQuoteWire,
  type QuoteApprovalWire,
} from './quote-approval.service';

/** POST /invoices/{id}/send-quote */
export class SendQuoteDto {
  /** Override the destination (a relative's number, an alternative email). */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  send_to?: string;
}

/** POST /invoices/{id}/record-approval — the decision taken at the counter. */
export class RecordDecisionDto {
  @IsIn(['APPROVED', 'DECLINED'])
  decision!: 'APPROVED' | 'DECLINED';

  @IsIn(['COUNTER', 'PHONE'])
  via!: 'COUNTER' | 'PHONE';

  /** Required for a COUNTER approval — see the service for why. */
  @IsOptional()
  @IsUUID()
  signature_attachment_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /public/quote/{token}/decision */
export class PublicDecisionDto {
  @IsIn(['APPROVED', 'DECLINED'])
  decision!: 'APPROVED' | 'DECLINED';
}

/**
 * /api/v1/invoices/{id}/… — out-of-warranty financial authorization
 * (SCMS proposal Module 5, §6).
 *
 *   GET  /invoices/{id}/approval          'invoice.read'
 *   POST /invoices/{id}/send-quote        'invoice.create'
 *   POST /invoices/{id}/record-approval   'invoice.create'
 */
@Controller('invoices')
@UseGuards(AuthGuard, PermissionsGuard)
export class QuoteApprovalController {
  constructor(private readonly quotes: QuoteApprovalService) {}

  @Get(':id/approval')
  @RequirePermissions('invoice.read')
  status(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<QuoteApprovalWire> {
    return this.quotes.status(id);
  }

  @Post(':id/send-quote')
  @RequirePermissions('invoice.create')
  @HttpCode(HttpStatus.OK)
  send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendQuoteDto,
    @CurrentUser() user: AuthUser,
  ): Promise<QuoteApprovalWire> {
    return this.quotes.send(id, dto.send_to ?? null, user);
  }

  @Post(':id/record-approval')
  @RequirePermissions('invoice.create')
  @HttpCode(HttpStatus.OK)
  record(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordDecisionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<QuoteApprovalWire> {
    return this.quotes.recordCounterDecision(id, dto, user);
  }
}

/**
 * /api/v1/public/quote/{token} — the customer-facing approval page.
 *
 * DELIBERATELY UNAUTHENTICATED, on the same terms as the CSAT survey: the
 * recipient has no account, the hashed 32-byte token is the credential, it is
 * single-purpose (one invoice), it expires, and it is BURNED the moment a
 * decision is recorded. The response carries only what the page must show —
 * the quote lines and totals — and never the customer's contact details or
 * anything about other jobs.
 */
@Controller('public/quote')
export class PublicQuoteController {
  constructor(private readonly quotes: QuoteApprovalService) {}

  @Get(':token')
  view(@Param('token') token: string): Promise<PublicQuoteWire> {
    return this.quotes.publicView(token);
  }

  @Post(':token/decision')
  @HttpCode(HttpStatus.OK)
  decide(
    @Param('token') token: string,
    @Body() dto: PublicDecisionDto,
  ): Promise<PublicQuoteWire> {
    return this.quotes.publicDecide(token, dto.decision);
  }
}
