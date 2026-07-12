import { LabourCode } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
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

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
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
