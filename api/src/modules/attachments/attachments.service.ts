import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentKind, AttachmentOwnerType, Prisma } from '@prisma/client';
import type { PaginatedResponse } from '@triserve/shared';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_PRESIGNED_URL_TTL_SECONDS,
  envNumber,
  PNG_MAGIC_BYTES,
} from './attachments.constants';
import type {
  AttachmentListQueryDto,
  CreateAttachmentDto,
  CreateSignatureDto,
} from './dto/attachment.dto';
import { STORAGE_SERVICE, type StorageService } from '../storage/storage.types';

/** Wire shape of one attachment (snake_case per API convention). `url` is a
 * FRESH presigned/signed GET URL, minted on every read — never a stored,
 * reusable value (the raw storage key never leaves the API). */
export interface AttachmentWire {
  id: string;
  company_id: string;
  branch_id: string | null;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  kind: AttachmentKind;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  url: string;
  created_at: string;
}

type AttachmentRow = Prisma.AttachmentGetPayload<Record<string, never>>;

/**
 * Attachments — polymorphic file store (Task 1.4, DESIGN.md §4.12).
 *
 * Files never touch the DB: `putObject` writes to the StorageService (S3 or
 * local driver, see storage.module.ts) under key
 * `{companyId}/{owner_type}/{owner_id}/{uuid}{ext}`; the row stores that KEY
 * (in `file_url`) — never a browsable URL. `url` in every wire response is a
 * FRESH presigned/signed GET URL minted at read time (short TTL).
 *
 * SCOPING: company_id is enforced by the generic Prisma extension (Attachment
 * is in COMPANY_SCOPED_MODELS). branch_id is derived from the owning JOB at
 * upload time (null for company-level CUSTOMER/DEVICE owners) and is
 * DELIBERATELY handled manually here rather than via BRANCH_SCOPED_MODELS —
 * see the doc comment on Attachment in schema.prisma and on
 * BRANCH_SCOPED_MODELS in company-scope.extension.ts for why (nullable
 * branch_id needs OR-null semantics the generic extension's equality filter
 * can't express).
 */
@Injectable()
export class AttachmentsService {
  private readonly maxFileSizeBytes: number;
  private readonly presignedUrlTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {
    this.maxFileSizeBytes = envNumber(
      this.config,
      'STORAGE_MAX_FILE_SIZE_BYTES',
      DEFAULT_MAX_FILE_SIZE_BYTES,
    );
    this.presignedUrlTtlSeconds = envNumber(
      this.config,
      'STORAGE_URL_TTL_SECONDS',
      DEFAULT_PRESIGNED_URL_TTL_SECONDS,
    );
  }

  // ---------------------------------------------------------------- queries

  /** GET /attachments?owner_type=&owner_id= — company/branch scoped. */
  async list(
    query: AttachmentListQueryDto,
    user: AuthUser,
  ): Promise<PaginatedResponse<AttachmentWire>> {
    const where: Prisma.AttachmentWhereInput = {
      companyId: user.companyId,
      ownerType: query.owner_type,
      ownerId: query.owner_id,
      ...this.branchScopeWhere(user),
    };

    const rows = await this.prisma.attachment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const data = await Promise.all(rows.map((r) => this.toWire(r)));
    return { data, page: 1, page_size: data.length || 1, total: data.length };
  }

  // -------------------------------------------------------------- mutations

  /** POST /attachments (multipart) — validated before ever touching storage. */
  async upload(
    file: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
      size: number;
    },
    dto: CreateAttachmentDto,
    user: AuthUser,
  ): Promise<AttachmentWire> {
    if (dto.kind === AttachmentKind.SIGNATURE) {
      throw new BadRequestException(
        'Use POST /attachments/signature to attach a SIGNATURE',
      );
    }
    if (!file) {
      throw new BadRequestException('A file is required');
    }

    const ext = this.assertAllowedFile(file.mimetype, file.size);
    const branchId = await this.resolveOwnerBranch(
      dto.owner_type,
      dto.owner_id,
    );

    const key = this.buildKey(
      user.companyId,
      dto.owner_type,
      dto.owner_id,
      ext,
    );
    await this.storage.putObject(key, file.buffer, file.mimetype);

    const row = await this.prisma.attachment.create({
      data: {
        companyId: user.companyId,
        branchId,
        ownerType: dto.owner_type,
        ownerId: dto.owner_id,
        kind: dto.kind,
        fileUrl: key,
        fileName: file.originalname || `${randomUUID()}${ext}`,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        uploadedById: user.userId,
      },
    });

    return this.toWire(row);
  }

  /** POST /attachments/signature — a PNG data-URI, always JOB-owned. */
  async uploadSignature(
    dto: CreateSignatureDto,
    user: AuthUser,
  ): Promise<AttachmentWire> {
    const buffer = this.decodePngDataUri(dto.data_uri);
    this.assertAllowedFile('image/png', buffer.length);

    const branchId = await this.resolveOwnerBranch(
      AttachmentOwnerType.JOB,
      dto.owner_id,
    );

    const key = this.buildKey(
      user.companyId,
      AttachmentOwnerType.JOB,
      dto.owner_id,
      '.png',
    );
    await this.storage.putObject(key, buffer, 'image/png');

    const row = await this.prisma.attachment.create({
      data: {
        companyId: user.companyId,
        branchId,
        ownerType: AttachmentOwnerType.JOB,
        ownerId: dto.owner_id,
        kind: AttachmentKind.SIGNATURE,
        fileUrl: key,
        fileName: 'signature.png',
        mimeType: 'image/png',
        sizeBytes: buffer.length,
        uploadedById: user.userId,
      },
    });

    return this.toWire(row);
  }

  /** DELETE /attachments/{id} — removes the object THEN the row (audited). */
  async remove(id: string, user: AuthUser): Promise<void> {
    const row = await this.prisma.attachment.findFirst({
      where: {
        id,
        companyId: user.companyId,
        ...this.branchScopeWhere(user),
      },
    });
    if (!row) throw new NotFoundException('Attachment not found');

    await this.storage.deleteObject(row.fileUrl);
    // The audit extension captures the DELETE row (before-snapshot incl. the
    // storage key) atomically with this delete.
    await this.prisma.attachment.delete({ where: { id: row.id } });
  }

  // ---------------------------------------------------------------- helpers

  /**
   * scope='branch' users see: attachments on THEIR branch (JOB-owned) PLUS
   * every company-level attachment (branch_id = NULL, i.e. CUSTOMER/DEVICE
   * owners) — an OR, not the generic extension's blunt equality filter.
   * scope='group' users are unrestricted (company scoping alone applies).
   */
  private branchScopeWhere(user: AuthUser): Prisma.AttachmentWhereInput {
    if (user.scope !== 'branch' || !user.homeBranchId) return {};
    return { OR: [{ branchId: null }, { branchId: user.homeBranchId }] };
  }

  /**
   * Validate the owner exists (company/branch-scoped read) and derive the
   * attachment's branch_id. JOB owners: the Prisma company-scope extension
   * ALREADY restricts a scope='branch' user's Job reads to their home branch
   * (Job is in BRANCH_SCOPED_MODELS) — so a not-found here for a
   * cross-branch job is the access check, with no separate
   * assertBranchAccess call needed. CUSTOMER/DEVICE are company-level (no
   * branch_id). GRN/INVOICE: those tables don't exist yet in this phase —
   * accepted, branch_id stays null, no existence check (documented gap; add
   * one when those modules land).
   */
  private async resolveOwnerBranch(
    ownerType: AttachmentOwnerType,
    ownerId: string,
  ): Promise<string | null> {
    switch (ownerType) {
      case AttachmentOwnerType.JOB: {
        const job = await this.prisma.job.findFirst({
          where: { id: ownerId, deletedAt: null },
        });
        if (!job) {
          throw new BadRequestException(
            'owner_id does not match a job of your company/branch',
          );
        }
        return job.branchId;
      }
      case AttachmentOwnerType.CUSTOMER: {
        const customer = await this.prisma.customer.findFirst({
          where: { id: ownerId, deletedAt: null },
        });
        if (!customer) {
          throw new BadRequestException(
            'owner_id does not match a customer of your company',
          );
        }
        return null;
      }
      case AttachmentOwnerType.DEVICE: {
        const device = await this.prisma.device.findFirst({
          where: { id: ownerId, deletedAt: null },
        });
        if (!device) {
          throw new BadRequestException(
            'owner_id does not match a device of your company',
          );
        }
        return null;
      }
      case AttachmentOwnerType.GRN:
      case AttachmentOwnerType.INVOICE:
        // Not implemented yet in this phase — accepted for forward
        // compatibility with the §4.12 enum; no existence check possible.
        return null;
      /* istanbul ignore next -- exhaustive switch over a Prisma enum */
      default:
        return null;
    }
  }

  /** mime/size allowlist gate — throws BadRequest(400)/PayloadTooLarge(413). */
  private assertAllowedFile(mimetype: string, size: number): string {
    const ext = ALLOWED_MIME_TYPES.get(mimetype);
    if (!ext) {
      throw new BadRequestException(`Unsupported file type: ${mimetype}`);
    }
    if (size > this.maxFileSizeBytes) {
      throw new PayloadTooLargeException(
        `File exceeds the ${this.maxFileSizeBytes}-byte limit`,
      );
    }
    return ext;
  }

  /** Decode + validate a `data:image/png;base64,...` signature data-URI. */
  private decodePngDataUri(dataUri: string): Buffer {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
    if (!match) {
      throw new BadRequestException(
        'data_uri must be a base64 image/png data URI',
      );
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(match[1], 'base64');
    } catch {
      throw new BadRequestException('data_uri is not valid base64');
    }
    if (
      buffer.length < PNG_MAGIC_BYTES.length ||
      !buffer.subarray(0, PNG_MAGIC_BYTES.length).equals(PNG_MAGIC_BYTES)
    ) {
      throw new BadRequestException('data_uri is not a valid PNG image');
    }
    return buffer;
  }

  private buildKey(
    companyId: string,
    ownerType: AttachmentOwnerType,
    ownerId: string,
    ext: string,
  ): string {
    return `${companyId}/${ownerType}/${ownerId}/${randomUUID()}${ext}`;
  }

  private async toWire(row: AttachmentRow): Promise<AttachmentWire> {
    const url = await this.storage.getPresignedGetUrl(
      row.fileUrl,
      this.presignedUrlTtlSeconds,
      row.mimeType,
    );
    return {
      id: row.id,
      company_id: row.companyId,
      branch_id: row.branchId,
      owner_type: row.ownerType,
      owner_id: row.ownerId,
      kind: row.kind,
      file_name: row.fileName,
      mime_type: row.mimeType,
      size_bytes: row.sizeBytes,
      uploaded_by: row.uploadedById,
      url,
      created_at: row.createdAt.toISOString(),
    };
  }
}
