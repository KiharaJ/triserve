import { PaymentMethodType } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

const MINOR_UNITS = /^\d{1,15}$/;

/**
 * POST /invoices/{id}/payments — record one payment (§4.6). Multiple payments
 * give the deposit → balance → paid pattern. `amount` is minor units; must be
 * > 0 and not exceed the outstanding balance.
 */
export class RecordPaymentDto {
  @IsEnum(PaymentMethodType)
  method!: PaymentMethodType;

  @Matches(MINOR_UNITS, { message: 'amount must be minor units (digits only)' })
  amount!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Gateway/txn reference — M-Pesa code, card auth, bank ref, … */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsISO8601()
  paid_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** GET /payments?invoice_id=&method=&branch_id=&from=&to=&page= */
export class PaymentListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  invoice_id?: string;

  @IsOptional()
  @IsEnum(PaymentMethodType)
  method?: PaymentMethodType;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
