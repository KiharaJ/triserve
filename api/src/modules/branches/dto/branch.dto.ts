import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** GET /branches?q=&active=&page=&page_size= */
export class BranchListQueryDto extends ListQueryDto {
  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/** POST /branches */
export class CreateBranchDto {
  /** Short branch code, e.g. "DAR" — unique per company. */
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  @Matches(/^[A-Z0-9_-]+$/i, {
    message: 'code may only contain letters, digits, "-" and "_"',
  })
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsBoolean()
  is_hq?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tz_region?: string;
}

/** PATCH /branches/{id} — all fields optional. */
export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  @Matches(/^[A-Z0-9_-]+$/i, {
    message: 'code may only contain letters, digits, "-" and "_"',
  })
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsBoolean()
  is_hq?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tz_region?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
