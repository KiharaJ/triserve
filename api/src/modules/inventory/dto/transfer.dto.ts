import { StockTransferStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/** One part + quantity on a transfer. */
export class TransferLineInput {
  @IsUUID()
  part_id!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  qty!: number;
}

/**
 * POST /transfers — draft an inter-branch transfer (§4.4). No stock moves yet;
 * dispatch() posts TRANSFER_OUT at the source, receive() posts TRANSFER_IN at
 * the destination. `from_branch_id` must differ from `to_branch_id`.
 */
export class CreateTransferDto {
  @IsUUID()
  from_branch_id!: string;

  @IsUUID()
  to_branch_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferLineInput)
  lines!: TransferLineInput[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** GET /transfers?status=&branch_id=&q=&page= */
export class TransferListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(StockTransferStatus)
  status?: StockTransferStatus;

  /** Transfers where this branch is the source OR the destination. */
  @IsOptional()
  @IsUUID()
  branch_id?: string;
}
