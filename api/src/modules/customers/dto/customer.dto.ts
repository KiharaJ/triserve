import { CustomerType, PreferredLanguage } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * GET /customers?q=&branch_id=&page=&page_size=
 * `q` matches name OR phone (normalized before matching, so any of the
 * messy legacy formats finds the customer); `branch_id` filters by
 * preferred branch.
 */
export class CustomerListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;
}

/** POST /customers */
export class CreateCustomerDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  alt_phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  /** Individual / Business / Dealer. `is_dealer` is derived from this. */
  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  dealer_name?: string;

  /** Legacy dealer flag; ignored when `type` is provided (kept for back-compat). */
  @IsOptional()
  @IsBoolean()
  is_dealer?: boolean;

  @IsOptional()
  @IsUUID()
  preferred_branch_id?: string;

  @IsOptional()
  @IsEnum(PreferredLanguage)
  preferred_language?: PreferredLanguage;

  /** 1–5 internal rating/flag. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

/** PATCH /customers/{id} — all fields optional. */
export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  alt_phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  location?: string;

  /** Individual / Business / Dealer. `is_dealer` is derived from this. */
  @IsOptional()
  @IsEnum(CustomerType)
  type?: CustomerType;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  dealer_name?: string;

  /** Legacy dealer flag; ignored when `type` is provided (kept for back-compat). */
  @IsOptional()
  @IsBoolean()
  is_dealer?: boolean;

  @IsOptional()
  @IsUUID()
  preferred_branch_id?: string;

  @IsOptional()
  @IsEnum(PreferredLanguage)
  preferred_language?: PreferredLanguage;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
