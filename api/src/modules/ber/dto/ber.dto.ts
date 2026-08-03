import { BerOutcome, BerStatus, DeviceCategory, SwapUnitStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * POST /jobs/{id}/ber/evaluate (SCMS proposal §5 step 1).
 *
 * Every input is optional: the whole point is that the system computes the
 * ratio from what it already knows (reserved/consumed parts, declared labour,
 * the model's market value). The overrides exist for the cases where it
 * genuinely cannot — a supervisor valuing a five-year-old handset the
 * catalogue has no figure for, or costing labour before any hours are logged.
 * Whichever source was used is recorded on the assessment.
 */
export class EvaluateBerDto {
  /** Override the estimated parts total, minor units. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'parts_cost must be minor units (digits only)',
  })
  parts_cost?: string;

  /** Override the estimated labour total, minor units. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'labour_cost must be minor units (digits only)',
  })
  labour_cost?: string;

  /** Override the device's fair commercial market value, minor units. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'device_value must be minor units (digits only)',
  })
  device_value?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  /**
   * Compute and return the numbers WITHOUT writing an assessment or locking
   * the technician out. The bench uses this to sanity-check a repair before
   * committing to it; a real evaluation is a formal event.
   */
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  dry_run?: boolean;
}

/**
 * POST /ber/{id}/certify (SCMS proposal §5 step 2) — the Workshop Supervisor
 * confirms the calculation and the device is formally Beyond Economic Repair.
 * Approval-gated (BER_CERTIFICATION).
 */
export class CertifyBerDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  notes!: string;

  /** Request a manager override when the actor's own limit does not cover it. */
  @IsOptional()
  @IsBoolean()
  request_override?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  override_reason?: string;

  @IsOptional()
  @IsUUID()
  override_approval_id?: string;
}

/** POST /ber/{id}/reject — the supervisor puts the job back on the repair track. */
export class RejectBerDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  notes!: string;
}

/**
 * POST /ber/{id}/outcome (SCMS proposal §5 step 3) — what the customer chose
 * once the certificate was issued.
 */
export class BerOutcomeDto {
  @IsEnum(BerOutcome)
  outcome!: BerOutcome;

  /** Salvage value or trade-up discount offered, minor units. */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'offer_amount must be minor units (digits only)',
  })
  offer_amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class BerListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(BerStatus)
  status?: BerStatus;

  @IsOptional()
  @IsUUID()
  job_id?: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;
}

// ---------------------------------------------------------------------------
// Swap buffer stock (proposal §5 step 4)
// ---------------------------------------------------------------------------

export class SwapUnitListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(SwapUnitStatus)
  status?: SwapUnitStatus;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;
}

export class UpsertSwapUnitDto {
  @IsUUID()
  branch_id!: string;

  @IsOptional()
  @IsUUID()
  model_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  model_label?: string;

  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  /** The replacement unit's own IMEI/serial. */
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  imei_serial!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  color?: string;

  @IsOptional()
  @Matches(/^\d{1,15}$/, { message: 'cost must be minor units (digits only)' })
  cost?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/**
 * POST /jobs/{id}/swap (SCMS proposal §5 steps 4–5) — issue a replacement from
 * the Swap Buffer Stock and realign the customer's primary device identity.
 */
export class ExecuteSwapDto {
  @IsUUID()
  swap_unit_id!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsBoolean()
  request_override?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  override_reason?: string;

  @IsOptional()
  @IsUUID()
  override_approval_id?: string;
}
