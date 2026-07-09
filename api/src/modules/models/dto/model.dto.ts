import { DeviceCategory } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { BooleanQuery, ListQueryDto } from '../../../common/dto/list-query.dto';

/** GET /models?q=&category=&active=&page=&page_size= */
export class ModelListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsEnum(DeviceCategory)
  category?: DeviceCategory;

  @IsOptional()
  @BooleanQuery()
  active?: boolean;
}

/** POST /models */
export class CreateModelDto {
  /** e.g. "A05", "S23 Ultra", "UA40M5000" — unique per (company, brand). */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model_code!: string;

  @IsEnum(DeviceCategory)
  category!: DeviceCategory;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  brand?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
