import { PurchaseOrderStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
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
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** One part + qty + agreed unit cost (minor-unit string) on a PO line. */
export class PoLineInput {
  @IsUUID()
  part_id!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  qty_ordered!: number;

  @Matches(MINOR_UNITS, {
    message: 'unit_cost must be minor units (digits only)',
  })
  unit_cost!: string;
}

/**
 * POST /purchase-orders — draft an order to a supplier (§4.4b). `branch_id` is
 * the destination branch (required for group users; branch users default to
 * their home branch). Currency defaults to the supplier's. tax/shipping are
 * minor-unit strings in the PO currency; the subtotal/total are computed.
 */
export class CreatePurchaseOrderDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsUUID()
  supplier_id!: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, { message: 'expected_date must be YYYY-MM-DD' })
  expected_date?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'tax must be minor units (digits only)' })
  tax?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'shipping must be minor units (digits only)',
  })
  shipping?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoLineInput)
  lines!: PoLineInput[];
}

/** PATCH /purchase-orders/{id} — DRAFT only. Lines, when given, replace all. */
export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, { message: 'expected_date must be YYYY-MM-DD' })
  expected_date?: string | null;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'tax must be minor units (digits only)' })
  tax?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'shipping must be minor units (digits only)',
  })
  shipping?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoLineInput)
  lines?: PoLineInput[];
}

/** GET /purchase-orders?status=&supplier_id=&branch_id=&q=&page= */
export class PurchaseOrderListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @IsOptional()
  @IsUUID()
  supplier_id?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;
}
