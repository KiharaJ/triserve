import { RoleLimitType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * PUT /roles/{role}/limits — set one financial ceiling for a role
 * (SCMS proposal Module 5, §6).
 *
 * Omitting BOTH ceilings while `enabled` is true means "authorised, no bound",
 * which is the same as `enabled: false`; the explicit flag is preferred
 * because it reads unambiguously in the admin UI. Deleting the row instead
 * revokes the authority altogether — see RoleLimitsService for the three-state
 * semantics.
 */
export class UpsertRoleLimitDto {
  @IsEnum(RoleLimitType)
  type!: RoleLimitType;

  /** Ceiling in minor units of `currency`; "0" means "not permitted at all". */
  @IsOptional()
  @Matches(/^\d{1,15}$/, {
    message: 'max_amount must be minor units (digits only)',
  })
  max_amount?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string | null;

  /** Ceiling as a percentage of the document total, e.g. "12.5". */
  @IsOptional()
  @Matches(/^\d{1,3}(\.\d{1,3})?$/, {
    message: 'max_percent must be a percentage like "12.5"',
  })
  max_percent?: string | null;

  /** false = this role has NO ceiling for this action (full authorisation). */
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
