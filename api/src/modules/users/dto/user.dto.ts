import { UserScope } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Matches,
  MinLength,
} from 'class-validator';
import { ROLE_KEY_PATTERN } from '@triserve/shared';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** GET /users?role=&branch_id=&active=&q=&page=&page_size= */
export class UserListQueryDto extends ListQueryDto {
  /** Filter by role KEY (built-in or custom). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  role?: string;

  /** Filter by home branch. */
  @IsOptional()
  @IsString()
  @Length(36, 36)
  branch_id?: string;

  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/** POST /users. */
export class CreateUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  full_name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  initials?: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  /** Initial password — hashed with argon2id, never stored or echoed raw. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  /** A role KEY (built-in or custom) — existence validated in the service. */
  @IsString()
  @Matches(ROLE_KEY_PATTERN, { message: 'Invalid role' })
  role!: string;

  @IsEnum(UserScope)
  scope!: UserScope;

  /** Required when scope = 'branch'. */
  @IsOptional()
  @IsString()
  @Length(36, 36)
  home_branch_id?: string;
}

/** PATCH /users/{id} — everything optional; password resets when present. */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  full_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  initials?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  @Matches(ROLE_KEY_PATTERN, { message: 'Invalid role' })
  role?: string;

  @IsOptional()
  @IsEnum(UserScope)
  scope?: UserScope;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  home_branch_id?: string | null;
}
