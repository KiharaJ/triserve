import {
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ALL_PERMISSIONS,
  ROLE_KEY_PATTERN,
  type Permission,
} from '@triserve/shared';

/** POST /roles — create a custom role. */
export class CreateRoleDto {
  /** Optional explicit key; derived from `label` when omitted. */
  @IsOptional()
  @IsString()
  @Matches(ROLE_KEY_PATTERN, {
    message: 'Key must be UPPER_SNAKE (start with a letter, 2–50 chars)',
  })
  key?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  /** Seed the new role's permissions with these (defaults to none). */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(ALL_PERMISSIONS as readonly string[], {
    each: true,
    message: 'Unknown permission',
  })
  permissions?: Permission[];

  /** Or clone the effective permissions of an existing role key. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  clone_from?: string;
}

/** PATCH /roles/{role} — rename / re-describe a custom role. */
export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
