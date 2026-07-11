import { InvoiceLineType, InvoiceType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

const MINOR_UNITS = /^\d{1,15}$/;

/** One line on an invoice — a part, product, service or free-text item. */
export class InvoiceLineInput {
  @IsEnum(InvoiceLineType)
  line_type!: InvoiceLineType;

  /** Required for PART lines (links the catalogue); ignored otherwise. */
  @IsOptional()
  @IsUUID()
  part_id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  qty!: number;

  @Matches(MINOR_UNITS, {
    message: 'unit_price must be minor units (digits only)',
  })
  unit_price!: string;

  @IsOptional()
  @IsBoolean()
  is_warranty?: boolean;
}

/**
 * POST /invoices — a DRAFT OW sale (§4.6). `branch_id` defaults to the seller's
 * branch; `customer_id`/`job_id` are optional (walk-in allowed). tax/discount
 * are minor-unit strings; subtotal/total are computed.
 */
export class CreateInvoiceDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  job_id?: string;

  @IsEnum(InvoiceType)
  type!: InvoiceType;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'discount must be minor units (digits only)',
  })
  discount?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'tax must be minor units (digits only)' })
  tax?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineInput)
  lines!: InvoiceLineInput[];
}

/** PATCH /invoices/{id} — DRAFT only; lines (if given) replace all. */
export class UpdateInvoiceDto {
  @IsOptional()
  @IsUUID()
  customer_id?: string | null;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'discount must be minor units (digits only)',
  })
  discount?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'tax must be minor units (digits only)' })
  tax?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceLineInput)
  lines?: InvoiceLineInput[];
}

/** POST /invoices/{id}/void — approval-gated (INVOICE_VOID). */
export class VoidInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** GET /invoices?status=&type=&branch_id=&customer_id=&job_id=&q=&page= */
export class InvoiceListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(InvoiceType)
  type?: InvoiceType;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  job_id?: string;
}
