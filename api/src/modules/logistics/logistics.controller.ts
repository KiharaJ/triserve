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
  UseGuards,
} from '@nestjs/common';
import type { PaginatedResponse } from '@triserve/shared';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import { ListQueryDto } from '../../common/dto/list-query.dto';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  CollectionOtpService,
  type CollectionOtpWire,
} from './collection-otp.service';
import {
  ConsignmentsService,
  type ConsignmentWire,
} from './consignments.service';
import { CsatService, type CsatWire } from './csat.service';
import {
  AddConsignmentJobsDto,
  ArriveConsignmentDto,
  ConsignmentListQueryDto,
  CreateConsignmentDto,
  DispatchConsignmentDto,
  IssueOtpDto,
  ScanConsignmentDto,
  VerifyOtpDto,
} from './dto/logistics.dto';

/**
 * /api/v1 — dispatch, hub logistics and final delivery
 * (SCMS proposal Module 6, §7).
 *
 *   GET  /jobs/{id}/collection-otp          'job.read'
 *   POST /jobs/{id}/collection-otp          'job.collection.otp.issue'
 *   POST /jobs/{id}/collection-otp/verify   'job.collection.otp.verify'
 *
 *   GET/POST /consignments                  'consignment.read' / '.manage'
 *   GET  /consignments/by-tote/{label}      'consignment.read'
 *   POST /consignments/{id}/jobs            'consignment.manage'
 *   POST /consignments/{id}/dispatch        'consignment.manage'
 *   POST /consignments/{id}/scan            'consignment.scan'
 *   POST /consignments/{id}/arrive          'consignment.manage'
 *   POST /consignments/{id}/cancel          'consignment.manage'
 *
 *   GET  /csat                              'report.view.branch'
 *
 * The PUBLIC survey endpoints live in {@link PublicCsatController} — they are
 * deliberately outside this guarded controller.
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class LogisticsController {
  constructor(
    private readonly otp: CollectionOtpService,
    private readonly consignments: ConsignmentsService,
    private readonly csat: CsatService,
  ) {}

  // ------------------------------------------------------ collection OTP

  @Get('jobs/:id/collection-otp')
  @RequirePermissions('job.read')
  otpStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CollectionOtpWire | null> {
    return this.otp.status(id, user);
  }

  @Post('jobs/:id/collection-otp')
  @RequirePermissions('job.collection.otp.issue')
  @HttpCode(HttpStatus.OK)
  issueOtp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueOtpDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CollectionOtpWire> {
    return this.otp.issue(id, dto.send_to ?? null, user);
  }

  @Post('jobs/:id/collection-otp/verify')
  @RequirePermissions('job.collection.otp.verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyOtpDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CollectionOtpWire> {
    return this.otp.verify(id, dto.code, user);
  }

  // -------------------------------------------------------- consignments

  @Get('consignments')
  @RequirePermissions('consignment.read')
  listConsignments(
    @Query() query: ConsignmentListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<ConsignmentWire>> {
    return this.consignments.list(query, user);
  }

  /**
   * Declared BEFORE ':id' so a tote lookup is not swallowed by the UUID route.
   */
  @Get('consignments/by-tote/:label')
  @RequirePermissions('consignment.read')
  byTote(@Param('label') label: string): Promise<ConsignmentWire> {
    return this.consignments.findByTote(label);
  }

  @Get('consignments/:id')
  @RequirePermissions('consignment.read')
  getConsignment(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConsignmentWire> {
    return this.consignments.get(id);
  }

  @Post('consignments')
  @RequirePermissions('consignment.manage')
  createConsignment(
    @Body() dto: CreateConsignmentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.create(dto, user);
  }

  @Post('consignments/:id/jobs')
  @RequirePermissions('consignment.manage')
  @HttpCode(HttpStatus.OK)
  addJobs(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddConsignmentJobsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.addJobs(id, dto, user);
  }

  @Delete('consignments/:id/jobs/:jobId')
  @RequirePermissions('consignment.manage')
  removeJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.removeJob(id, jobId, user);
  }

  @Post('consignments/:id/dispatch')
  @RequirePermissions('consignment.manage')
  @HttpCode(HttpStatus.OK)
  dispatchConsignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchConsignmentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.dispatch(id, dto, user);
  }

  @Post('consignments/:id/scan')
  @RequirePermissions('consignment.scan')
  @HttpCode(HttpStatus.OK)
  scan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScanConsignmentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.scan(id, dto, user);
  }

  @Post('consignments/:id/arrive')
  @RequirePermissions('consignment.manage')
  @HttpCode(HttpStatus.OK)
  arrive(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArriveConsignmentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.arrive(id, dto, user);
  }

  @Post('consignments/:id/cancel')
  @RequirePermissions('consignment.manage')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ConsignmentWire> {
    return this.consignments.cancel(id, user);
  }

  // ---------------------------------------------------------------- CSAT

  @Get('csat')
  @RequirePermissions('report.view.branch')
  listCsat(
    @Query() query: ListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<CsatWire>> {
    return this.csat.list(query, user);
  }
}
