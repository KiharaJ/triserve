import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { MULTER_HARD_CEILING_BYTES } from '../attachments/attachments.constants';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import type { ParsedJobCard } from './gspn-jobcard.parser';
import {
  CreateJobDto,
  DispatchJobDto,
  JobListQueryDto,
  TransitionJobDto,
  UpdateJobDto,
} from './dto/job.dto';
import {
  JobsService,
  type JobDetailWire,
  type JobWire,
  type TransitionResult,
} from './jobs.service';

/**
 * /api/v1/jobs (Task 1.3, DESIGN.md §4.3 / §5).
 *
 *   GET   /jobs?branch_id=&state=&assigned_engineer_id=&customer_id=&warranty_status=&q=&from=&to=&page=
 *                                                       'job.read'
 *   GET   /jobs/{id}                                    'job.read'
 *   POST  /jobs                                         'job.create'
 *   POST  /jobs/import/gspn-jobcard (multipart: file)   'job.create'
 *   PATCH /jobs/{id}                                    'job.update'
 *   POST  /jobs/{id}/transition {to_state_code, note}   'job.transition' (+ edge perm)
 *   POST  /jobs/{id}/dispatch   {received_by, waybill_no} 'job.transition.dispatch'
 *
 * Company + branch scoped; TECHNICIANs see only jobs assigned to them.
 * Status changes ONLY via /transition (and its /dispatch wrapper): the
 * endpoint guard enforces the broad job.transition permission and
 * WorkflowService enforces the specific edge's required_permission.
 * No DELETE: jobs are lifecycle/audit anchors (soft-delete arrives later).
 */
@Controller('jobs')
@UseGuards(AuthGuard, PermissionsGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * Parse an uploaded GSPN "Service Order Sheet" PDF into a DRAFT.
   *
   * Deliberately creates NOTHING: it returns fields for the intake form to
   * prefill, so a human still confirms the customer, the device and above all
   * the warranty coverage (which the PDF cannot tell us — see the parser).
   * Gated on `job.create` because that is who the draft is for.
   */
  @Post('import/gspn-jobcard')
  @RequirePermissions('job.create')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MULTER_HARD_CEILING_BYTES },
    }),
  )
  importJobCard(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<ParsedJobCard> {
    return this.jobs.parseJobCardPdf(file);
  }

  @Get()
  @RequirePermissions('job.read')
  list(
    @Query() query: JobListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<JobWire>> {
    return this.jobs.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('job.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.get(id, user);
  }

  @Post()
  @RequirePermissions('job.create')
  create(
    @Body() dto: CreateJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('job.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobDetailWire> {
    return this.jobs.update(id, dto, user);
  }

  @Post(':id/transition')
  @RequirePermissions('job.transition')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.jobs.transition(id, dto, user);
  }

  @Post(':id/dispatch')
  @RequirePermissions('job.transition.dispatch')
  dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchJobDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TransitionResult> {
    return this.jobs.dispatch(id, dto, user);
  }
}
