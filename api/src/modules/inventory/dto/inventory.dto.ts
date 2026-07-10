import { StockMovementType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * GET /inventory?branch_id=&part_id=&low_stock=&q=&page=
 * `q` matches the joined part's part_number / description; `low_stock=true`
 * returns only rows at/below reorder level (available <= reorder_level).
 */
export class InventoryListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  part_id?: string;

  @IsOptional()
  @BooleanQuery()
  low_stock?: boolean;
}

/**
 * GET /inventory/movements?branch_id=&part_id=&type=&ref_type=&from=&to=&page=
 * The append-only ledger view.
 */
export class MovementListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  part_id?: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * POST /inventory/adjust — a manual stock correction (§4.4). `delta` is the
 * SIGNED change to the on-hand (or damaged) bucket; a reason is mandatory
 * (§4.4 "reason required for ADJUSTMENT/DAMAGE"). `movement_type` picks the
 * bucket: ADJUSTMENT corrects on-hand (either sign), DAMAGE flags on-hand
 * stock as damaged (delta > 0). Approval-gated by value (INVENTORY_ADJUSTMENT).
 */
export class AdjustStockDto {
  @IsUUID()
  branch_id!: string;

  @IsUUID()
  part_id!: string;

  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  delta!: number;

  @IsOptional()
  @IsIn(['ADJUSTMENT', 'DAMAGE'])
  movement_type?: 'ADJUSTMENT' | 'DAMAGE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/**
 * POST /inventory/count — reconcile to a physical stock count (§4.4). The
 * service computes `delta = counted_qty − qty_on_hand` and posts the matching
 * ADJUSTMENT movement (ref_type COUNT). Approval-gated like a manual adjust.
 */
export class StockCountDto {
  @IsUUID()
  branch_id!: string;

  @IsUUID()
  part_id!: string;

  @IsInt()
  @Min(0)
  @Max(10_000_000)
  counted_qty!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * PATCH /inventory/settings — non-quantity stock settings (bin location,
 * reorder level). These do NOT move stock, so they are a direct update, not a
 * ledger movement. Creates the inventory row if the part has none at the
 * branch yet.
 */
export class InventorySettingsDto {
  @IsUUID()
  branch_id!: string;

  @IsUUID()
  part_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  bin_location?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  reorder_level?: number;
}
