import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * PATCH /api/v1/company (Task 0.7) — edit the caller's company profile.
 * Snake_case per wire convention. `base_currency` is deliberately NOT
 * editable here: changing the base currency of a live ledger is an
 * accounting migration, not a profile edit.
 */
export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  legal_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  tin?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  vrn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;
}
