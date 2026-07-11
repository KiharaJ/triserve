import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** GET /suppliers?active=&q= — `q` matches name / contact person. */
export class SupplierListQueryDto extends ListQueryDto {
  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/** POST /suppliers — a vendor we buy spares from (§4.4b). */
export class CreateSupplierDto {
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_person?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  default_currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  lead_time_days?: number;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  payment_terms?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** PATCH /suppliers/{id} — every field optional; `null` clears nullables. */
export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_person?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  default_currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  lead_time_days?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  payment_terms?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
