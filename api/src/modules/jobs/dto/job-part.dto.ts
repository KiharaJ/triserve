import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * POST /jobs/{id}/parts — commit a part to a job, RESERVING branch stock.
 * `unit_sell_price` (TZS minor-unit string) defaults to the part's catalogue
 * price; `is_warranty` defaults from the job's warranty status.
 */
export class AddJobPartDto {
  @IsUUID()
  part_id!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  qty!: number;

  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'unit_sell_price must be minor units (digits only)',
  })
  unit_sell_price?: string;

  @IsOptional()
  @IsBoolean()
  is_warranty?: boolean;
}
