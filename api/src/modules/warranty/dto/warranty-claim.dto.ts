import { LabourCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/** USD minor units (cents) on the wire — digits only, like all money. */
const MINOR_UNITS = /^\d{1,15}$/;

/**
 * POST /warranty-claims — open a DRAFT IW claim against a job (§4.7). The claim
 * value is USD minor units (cents). `claim_no` (Samsung's number) is usually
 * unknown at DRAFT and set on submit (Task 4.2), but may be provided up front.
 * `branch_id` defaults to the job's branch.
 */
export class CreateWarrantyClaimDto {
  @IsUUID()
  job_id!: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @Matches(MINOR_UNITS, {
    message: 'claim_amount_usd must be minor units (cents, digits only)',
  })
  claim_amount_usd!: string;

  @IsOptional()
  @IsEnum(LabourCode)
  labour_code?: LabourCode;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  claim_no?: string;

  /**
   * GSPN's other two identifiers plus its raw status string. Known up front
   * when the claim was read from a Warranty Claim Detail PDF; otherwise they
   * arrive on reconciliation.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  samsung_ref_no?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ticket_no?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  gspn_status?: string;

  /**
   * The cost breakdown GSPN settles on. Optional — a hand-raised claim states
   * only a total — but when supplied the components must sum to
   * `claim_amount_usd`, or the claim is rejected: a total that disagrees with
   * its own parts makes a short payment un-attributable, which is the whole
   * reason the split exists.
   */
  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'labour_amount_usd must be minor units' })
  labour_amount_usd?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'parts_amount_usd must be minor units' })
  parts_amount_usd?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'shipping_amount_usd must be minor units' })
  shipping_amount_usd?: string;

  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'tax_amount_usd must be minor units' })
  tax_amount_usd?: string;

  /** GSPN's own milestones, as filed — see the schema note on why they exist. */
  @IsOptional()
  @IsISO8601()
  repair_received_at?: string;

  @IsOptional()
  @IsISO8601()
  completed_at?: string;

  @IsOptional()
  @IsISO8601()
  delivered_at?: string;

  /** The parts claimed against Samsung, at THEIR reimbursement prices. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => WarrantyClaimLineInput)
  lines?: WarrantyClaimLineInput[];

  /**
   * Admin overrides (§4.11). A blocked create returns the guard's own error;
   * to get past it the operator asks for an override with
   * `request_override` + `override_reason` (which creates a PENDING approval
   * and performs NOTHING), and once it is approved retries this same request
   * with `override_approval_id`. One approval, one use.
   */
  @IsOptional()
  @IsBoolean()
  request_override?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  override_reason?: string;

  @IsOptional()
  @IsUUID()
  override_approval_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * One part line on a claim. Prices are Samsung's REIMBURSEMENT prices in USD
 * minor units — deliberately not the job's sell price. `part_id` links to our
 * catalogue when we stock the part; `part_no` is always kept so a filed claim
 * stays legible after a rename or delisting.
 */
export class WarrantyClaimLineInput {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  part_no!: string;

  @IsOptional()
  @IsUUID()
  part_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  location?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @Matches(MINOR_UNITS, { message: 'unit_price_usd must be minor units' })
  unit_price_usd!: string;

  /** Omit and it is computed as qty × unit price. */
  @IsOptional()
  @Matches(MINOR_UNITS, { message: 'amount_usd must be minor units' })
  amount_usd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  part_serial_no?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  invoice_no?: string;
}

/** PATCH /warranty-claims/{id} — DRAFT only; every field optional. */
export class UpdateWarrantyClaimDto {
  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'claim_amount_usd must be minor units (cents, digits only)',
  })
  claim_amount_usd?: string;

  @IsOptional()
  @IsEnum(LabourCode)
  labour_code?: LabourCode | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  claim_no?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

/**
 * POST /warranty-claims/{id}/submit — DRAFT → SUBMITTED. A Samsung claim number
 * is required to submit (provided here if not already set); labour_code may be
 * finalised at the same time.
 */
export class SubmitWarrantyClaimDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  claim_no?: string;

  @IsOptional()
  @IsEnum(LabourCode)
  labour_code?: LabourCode;
}

/**
 * POST /warranty-claims/{id}/reconcile — record Samsung's decision:
 *   - APPROVED (from SUBMITTED) → posts Dr AR–Samsung / Cr Warranty Revenue;
 *   - REJECTED (from SUBMITTED);
 *   - PAID (from APPROVED) → sets reimbursed_amount_usd (defaults to the claim)
 *     and posts Dr Bank / Cr AR–Samsung.
 */
export class ReconcileWarrantyClaimDto {
  @IsIn(['APPROVED', 'REJECTED', 'PAID'])
  outcome!: 'APPROVED' | 'REJECTED' | 'PAID';

  @IsOptional()
  @Matches(MINOR_UNITS, {
    message: 'reimbursed_amount_usd must be minor units (cents, digits only)',
  })
  reimbursed_amount_usd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/** GET /warranty-claims?status=&labour_code=&branch_id=&job_id=&q=&page= */
export class WarrantyClaimListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsEnum(LabourCode)
  labour_code?: LabourCode;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsOptional()
  @IsUUID()
  job_id?: string;
}
