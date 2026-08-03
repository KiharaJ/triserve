import { ConsignmentDirection, ConsignmentStatus, ScanPoint } from '@prisma/client';
import {
  ArrayMaxSize,
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
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

// ---------------------------------------------------------------------------
// Collection OTP (proposal §7 steps 1 & 4)
// ---------------------------------------------------------------------------

/** POST /jobs/{id}/collection-otp — issue (or re-issue) the handover PIN. */
export class IssueOtpDto {
  /**
   * Send to a different number than the customer's registered one — a
   * relative collecting on their behalf, say. Defaults to the customer's
   * number on file.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  send_to?: string;
}

/** POST /jobs/{id}/collection-otp/verify — the counter checks the code. */
export class VerifyOtpDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

// ---------------------------------------------------------------------------
// Consignments / logistics totes (proposal §7 steps 2–3)
// ---------------------------------------------------------------------------

export class ConsignmentListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(ConsignmentStatus)
  status?: ConsignmentStatus;

  @IsOptional()
  @IsEnum(ConsignmentDirection)
  direction?: ConsignmentDirection;

  @IsOptional()
  @IsUUID()
  from_branch_id?: string;

  @IsOptional()
  @IsUUID()
  to_branch_id?: string;
}

export class CreateConsignmentDto {
  @IsUUID()
  from_branch_id!: string;

  @IsUUID()
  to_branch_id!: string;

  @IsEnum(ConsignmentDirection)
  direction!: ConsignmentDirection;

  /**
   * The barcode on the physical tote. Optional: the system mints one when the
   * branch has no pre-printed labels.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(60)
  tote_label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier_ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  /** Jobs to pack immediately; more can be added while the tote is OPEN. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  job_ids?: string[];
}

export class AddConsignmentJobsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  job_ids!: string[];
}

export class DispatchConsignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  courier_ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  waybill_no?: string;
}

/** POST /consignments/{id}/scan — a chain-of-custody scan point. */
export class ScanConsignmentDto {
  @IsEnum(ScanPoint)
  scan_point!: ScanPoint;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  /** The courier employee's name when the handler is not a system user. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  handler_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * POST /consignments/{id}/arrive — check the tote in at the destination.
 * `job_ids` are the devices physically present; anything on the manifest and
 * NOT in this list stays unchecked and is reported as missing.
 */
export class ArriveConsignmentDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  job_ids?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

// ---------------------------------------------------------------------------
// CSAT (proposal §7 step 5)
// ---------------------------------------------------------------------------

/** POST /public/csat/{token} — the customer's answer (unauthenticated). */
export class SubmitCsatDto {
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
