import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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

/** One received PO line on a GRN. */
export class GrnLineInput {
  @IsUUID()
  po_line_id!: string;

  @IsInt()
  @Min(0)
  @Max(1_000_000)
  qty_received!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  qty_rejected?: number;

  /** Actual landed cost this delivery (defaults to the PO line's cost). */
  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'unit_cost must be minor units (digits only)',
  })
  unit_cost?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  bin_location?: string;
}

/**
 * POST /purchase-orders/{id}/receipts — post a goods received note against the
 * order (§4.4b). Moves stock immediately: each line with qty_received > 0
 * writes a RECEIPT and bumps the PO line. At least one line must receive stock.
 */
export class ReceiveGoodsDto {
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY, { message: 'received_date must be YYYY-MM-DD' })
  received_date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplier_delivery_ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GrnLineInput)
  lines!: GrnLineInput[];
}

/** GET /goods-received-notes?po_id=&branch_id=&q=&page= */
export class GrnListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  po_id?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;
}
