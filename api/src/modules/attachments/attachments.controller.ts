import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { PaginatedResponse } from '@triserve/shared';
import { memoryStorage } from 'multer';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import { MULTER_HARD_CEILING_BYTES } from './attachments.constants';
import { AttachmentsService, type AttachmentWire } from './attachments.service';
import {
  AttachmentListQueryDto,
  CreateAttachmentDto,
  CreateSignatureDto,
} from './dto/attachment.dto';

/**
 * /api/v1/attachments (Task 1.4, DESIGN.md §4.12).
 *
 *   GET    /attachments?owner_type=&owner_id=          'attachment.read'
 *   POST   /attachments (multipart: file + fields)      'attachment.create'
 *   POST   /attachments/signature {owner_id, data_uri}  'attachment.create'
 *   DELETE /attachments/{id}                            'attachment.delete'
 *
 * Company + branch scoped (see AttachmentsService's scoping doc comment).
 * The public signed-file-serving route (`GET /attachments/file/:token`)
 * lives on {@link AttachmentFileController} — deliberately NOT behind
 * AuthGuard, since it stands in for a real S3 presigned URL (see
 * signed-url.util.ts for why an HMAC-signed, expiring token is safe there).
 */
@Controller('attachments')
@UseGuards(AuthGuard, PermissionsGuard)
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @RequirePermissions('attachment.read')
  list(
    @Query() query: AttachmentListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<AttachmentWire>> {
    return this.attachments.list(query, user);
  }

  @Post()
  @RequirePermissions('attachment.create')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MULTER_HARD_CEILING_BYTES },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateAttachmentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttachmentWire> {
    return this.attachments.upload(file, dto, user);
  }

  @Post('signature')
  @RequirePermissions('attachment.create')
  uploadSignature(
    @Body() dto: CreateSignatureDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttachmentWire> {
    return this.attachments.uploadSignature(dto, user);
  }

  @Delete(':id')
  @RequirePermissions('attachment.delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.attachments.remove(id, user);
  }
}
