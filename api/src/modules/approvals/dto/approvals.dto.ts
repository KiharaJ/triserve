import { ApprovalStatus, ApprovalType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * /api/v1/approvals wire DTOs (Task 0.5, DESIGN.md §4.11 / E8).
 * Snake_case per API convention.
 */

/** GET /approvals?status=&type=&branch_id=&page=&page_size= */
export class ApprovalListQueryDto {
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  @IsOptional()
  @IsEnum(ApprovalType)
  type?: ApprovalType;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  branch_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;
}

/**
 * POST /approvals — raise a PENDING approval. Primarily a service-level
 * hook for later modules; the endpoint exists for completeness/testing and
 * is gated by 'approval.request'.
 */
export class CreateApprovalDto {
  @IsEnum(ApprovalType)
  type!: ApprovalType;

  @IsString()
  @Length(36, 36)
  branch_id!: string;

  /** Entity awaiting approval — optional: approval may precede the entity. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ref_type?: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  ref_id?: string;

  /** The proposed change (free-form JSON object, per type). */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /** Requester's justification (required, §4.11). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

/** POST /approvals/{id}/approve — reason optional. */
export class ApproveApprovalDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason?: string;
}

/** POST /approvals/{id}/reject — reason REQUIRED (endpoint contract). */
export class RejectApprovalDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
