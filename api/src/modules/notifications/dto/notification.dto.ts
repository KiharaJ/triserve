import { NotificationChannel, NotificationStatus, PreferredLanguage } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ListQueryDto } from '../../../common/dto/list-query.dto';

/**
 * GET /notifications — the outbox AND the CRM communication log (§4.13).
 * `q` matches the rendered body or the recipient address.
 */
export class NotificationListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  @IsOptional()
  @IsUUID()
  job_id?: string;

  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;

  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  event_code?: string;
}

/** GET /notification-templates */
export class TemplateListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  event_code?: string;

  @IsOptional()
  @IsEnum(NotificationChannel)
  channel?: NotificationChannel;
}

/** POST/PUT /notification-templates — upserted on (event, channel, language). */
export class UpsertTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  event_code!: string;

  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @IsOptional()
  @IsEnum(PreferredLanguage)
  language?: PreferredLanguage;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  /**
   * `{{token}}` placeholders are resolved from the event payload. Bounded at
   * 2000 chars: an SMS body far beyond one segment is nearly always a mistake,
   * and the column is TEXT so this is a usability bound, not a storage one.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}
