import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * GET /api/v1/audit-log query parameters (Task 0.4, DESIGN.md §7).
 * Snake_case per wire convention; all filters optional.
 */
export class AuditLogQueryDto {
  /** Prisma model name, e.g. "Branch". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  entity_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(36)
  actor_user_id?: string;

  /** Inclusive lower bound on `at` (ISO-8601). */
  @IsOptional()
  @IsISO8601()
  from?: string;

  /** Inclusive upper bound on `at` (ISO-8601). */
  @IsOptional()
  @IsISO8601()
  to?: string;

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
