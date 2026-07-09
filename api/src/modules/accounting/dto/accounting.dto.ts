import { AccountType, JournalSourceType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * /api/v1/accounts + /api/v1/journal-entries wire DTOs (Task 0.6, §4.9/E1).
 * Snake_case per API convention. Money is BIGINT minor units transported as
 * decimal STRINGS (JSON numbers cannot carry 64-bit money safely); integer
 * JSON numbers are accepted and normalized to strings for convenience.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Non-negative integer minor units, within BIGINT range by length. */
const MONEY = /^\d{1,18}$/;

/** Normalize integer JSON numbers to strings so MONEY validation applies. */
const moneyToString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? String(value)
    : value;

/** GET /accounts?type=&is_active=&page=&page_size= */
export class AccountListQueryDto {
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** A chart is small — default 100 (larger than the usual 20). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  page_size?: number;
}

/** GET /journal-entries?from=&to=&source_type=&page=&page_size= */
export class JournalEntryListQueryDto {
  /** Inclusive entry_date lower bound, YYYY-MM-DD. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  /** Inclusive entry_date upper bound, YYYY-MM-DD. */
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  @IsOptional()
  @IsEnum(JournalSourceType)
  source_type?: JournalSourceType;

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

/** One proposed debit/credit line. Exactly ONE of debit/credit must be > 0. */
export class JournalLineDto {
  @IsString()
  @Length(36, 36)
  account_id!: string;

  @IsOptional()
  @Transform(moneyToString)
  @IsString()
  @Matches(MONEY, {
    message: 'debit must be a non-negative integer (minor units)',
  })
  debit?: string;

  @IsOptional()
  @Transform(moneyToString)
  @IsString()
  @Matches(MONEY, {
    message: 'credit must be a non-negative integer (minor units)',
  })
  credit?: string;

  /** ISO-4217 code, e.g. TZS. All lines of one entry must share it. */
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;
}

/**
 * POST /journal-entries — PROPOSE a manual journal (Task 0.6 flow):
 * validated up front, then parked as a PENDING MANUAL_JOURNAL approval; it
 * becomes a ledger entry only via POST /journal-entries/{approvalId}/post
 * after a manager approves.
 */
export class CreateManualJournalDto {
  /** Optional — but when sent it MUST be MANUAL (the only client-writable source). */
  @IsOptional()
  @Equals('MANUAL', {
    message:
      'source_type must be MANUAL — other sources are posted by the system (Phase 3)',
  })
  source_type?: 'MANUAL';

  @Matches(DATE_ONLY, { message: 'entry_date must be a YYYY-MM-DD date' })
  entry_date!: string;

  /** Optional: company-level entries (e.g. adjustments) have no branch. */
  @IsOptional()
  @IsString()
  @Length(36, 36)
  branch_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  memo?: string;

  @IsArray()
  @ArrayMinSize(2, { message: 'a journal entry needs at least 2 lines' })
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];

  /** Justification for the MANUAL_JOURNAL approval (required, §4.11). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
