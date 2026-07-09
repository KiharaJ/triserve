import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Base query DTO for list endpoints (Task 0.7): the standard
 * `?page=&page_size=&q=` trio from the API conventions (§7). Extend it and
 * add endpoint-specific filters.
 */
export class ListQueryDto {
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

  /** Free-text search (matched against code/name/label per endpoint). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/**
 * Boolean query param ("true"/"false" strings on the wire). class-transformer
 * `@Type(() => Boolean)` coerces "false" to true, so transform explicitly.
 */
export function BooleanQuery(): PropertyDecorator {
  const transform = Transform(({ value }): unknown => {
    const v: unknown = value;
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return v; // let @IsBoolean reject anything else
  });
  const isBoolean = IsBoolean();
  return (target, key) => {
    transform(target, key);
    isBoolean(target, key);
  };
}
