import { AttachmentKind, AttachmentOwnerType } from '@prisma/client';
import { IsEnum, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * GET /attachments?owner_type=&owner_id= (§4.12). No pagination: a single
 * job/customer/device carries a handful of attachments at most.
 */
export class AttachmentListQueryDto {
  @IsEnum(AttachmentOwnerType)
  owner_type!: AttachmentOwnerType;

  @IsUUID()
  owner_id!: string;
}

/**
 * POST /attachments (multipart/form-data) — the file itself arrives via
 * `@UploadedFile()` (FileInterceptor('file')); these are the OTHER form
 * fields, which multipart delivers as plain strings.
 *
 * `kind` deliberately excludes SIGNATURE here — signatures are captured via
 * the dedicated POST /attachments/signature (data-URI) route; rejecting it
 * on the multipart path keeps the two capture flows unambiguous (enforced
 * in AttachmentsService, since class-validator can't easily express
 * "any enum value except one" without a custom validator).
 */
export class CreateAttachmentDto {
  @IsEnum(AttachmentOwnerType)
  owner_type!: AttachmentOwnerType;

  @IsUUID()
  owner_id!: string;

  @IsEnum(AttachmentKind)
  kind!: AttachmentKind;
}

/**
 * POST /attachments/signature — a PNG data-URI captured from an on-screen
 * signature canvas, always attached to a JOB (§4.12: "customer signature
 * before repair").
 */
export class CreateSignatureDto {
  @IsUUID()
  owner_id!: string;

  /** `data:image/png;base64,<...>` */
  @IsString()
  @MaxLength(10_000_000) // generous upper bound; the real cap is byte-decoded and enforced in the service
  data_uri!: string;
}
