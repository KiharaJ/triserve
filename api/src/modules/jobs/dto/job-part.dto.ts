import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
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

/**
 * POST /jobs/{id}/parts/{lineId}/issue (SCMS proposal §4 steps 2–3) — the
 * storekeeper hands the picked part to the technician.
 *
 * `serial_no` is the NEW unit's tracking serial. Optional here because plenty
 * of parts are not serial-tracked; it becomes MANDATORY in the service when
 * `parts.is_serialized` is true, since without it there is no "Serial Out" to
 * reconcile against the core coming back.
 */
export class IssueJobPartDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  serial_no?: string;
}

/**
 * POST /jobs/{id}/parts/{lineId}/core-return (SCMS proposal §4 step 4) — the
 * technician scans the OLD component into the secure return bin. This is the
 * interlock that releases the job to QC.
 */
export class ReturnCoreDto {
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  core_serial_no!: string;

  /** Overrides the branch's default core bin for this unit. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bin_location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
