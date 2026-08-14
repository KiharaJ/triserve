import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PermissionsGuard } from '../../common/authz/permissions.guard';
import { RequirePermissions } from '../../common/authz/require-permissions.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  AddJobPartDto,
  IssueJobPartDto,
  RejectJobPartDto,
  ReturnCoreDto,
} from './dto/job-part.dto';
import {
  JobPartsService,
  type CoreStatusWire,
  type JobPartWire,
  type PickingTicketWire,
} from './job-parts.service';

/**
 * /api/v1/jobs/{jobId}/parts (Task 2.2, DESIGN.md §4.5) — parts on a job.
 *
 *   GET    /jobs/{jobId}/parts                    'job.read'
 *   POST   /jobs/{jobId}/parts        (reserve)   'inventory.reserve'
 *   DELETE /jobs/{jobId}/parts/{id}   (unreserve) 'inventory.reserve'
 *   POST   /jobs/{jobId}/parts/consume      (all) 'inventory.consume'
 *   POST   /jobs/{jobId}/parts/{id}/consume       'inventory.consume'
 *
 * SCMS proposal Module 3 (the closed-loop core exchange) adds:
 *   GET    /jobs/{jobId}/parts/picking-ticket     'inventory.read'
 *   POST   /jobs/{jobId}/parts/{id}/issue         'inventory.issue'
 *   POST   /jobs/{jobId}/parts/{id}/core-return   'inventory.core.return'
 *   GET    /jobs/{jobId}/parts/core-status        'job.read'
 *
 * Every stock effect runs through InventoryService.applyMovement (ref JOB) in
 * one transaction with the line. Access is gated through the parent job's
 * scope (a TECHNICIAN can only touch parts on jobs assigned to them).
 */
@Controller('jobs/:jobId/parts')
@UseGuards(AuthGuard, PermissionsGuard)
export class JobPartsController {
  constructor(private readonly jobParts: JobPartsService) {}

  @Get()
  @RequirePermissions('job.read')
  list(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire[]> {
    return this.jobParts.list(jobId, user);
  }

  /**
   * The technician ASKS for a part. Holds no stock — an approver reserving it
   * is what does that (see `approve`).
   */
  @Post()
  @RequirePermissions('inventory.reserve')
  request(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: AddJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.request(
      jobId,
      {
        part_id: dto.part_id,
        qty: dto.qty,
        unit_sell_price: dto.unit_sell_price,
        is_warranty: dto.is_warranty,
        request_note: dto.request_note,
      },
      user,
    );
  }

  // -- SCMS proposal Module 3: the closed-loop core exchange ---------------
  //
  // These two literal routes are declared BEFORE the ':lineId' routes below.
  // Nest matches in declaration order, so 'picking-ticket' would otherwise be
  // swallowed by ':lineId' and fail UUID validation.

  @Get('picking-ticket')
  @RequirePermissions('inventory.read')
  pickingTicket(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PickingTicketWire> {
    return this.jobParts.pickingTicket(jobId, user);
  }

  @Get('core-status')
  @RequirePermissions('job.read')
  coreStatus(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<CoreStatusWire> {
    return this.jobParts.coreStatus(jobId, user);
  }

  /**
   * The parts clerk picks up a bench request and raises it for approval.
   * Gated on 'inventory.issue' — the same permission as handing the part over,
   * because this is the same person doing the storekeeping.
   */
  @Post(':lineId/issue-request')
  @RequirePermissions('inventory.issue')
  raiseIssueRequest(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.raiseIssueRequest(jobId, lineId, user);
  }

  /** The parts clerk bounces a request back without troubling an approver. */
  @Post(':lineId/decline')
  @RequirePermissions('inventory.issue')
  decline(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: RejectJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.declineRequest(jobId, lineId, dto.reason, user);
  }

  /**
   * Approve a bench request — and reserve the stock in the same transaction.
   *
   * Gated on 'job.parts.approve' — deliberately its own permission, so the
   * managers who sign off parts need not also be the people who approve
   * refunds and purchase orders. The generic approvals inbox LISTS parts
   * requests but refuses to decide them: approving reserves stock and can fail
   * when the part has gone, which a notification-style approve cannot express.
   */
  @Post(':lineId/approve')
  @RequirePermissions('job.parts.approve')
  approve(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.approve(jobId, lineId, user);
  }

  @Post(':lineId/reject')
  @RequirePermissions('job.parts.approve')
  reject(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: RejectJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.reject(jobId, lineId, dto.reason, user);
  }

  /**
   * The technician confirms the part reached them. Gated on the permission
   * technicians already hold for fitting parts — the person who will fit it is
   * the person who signs for it.
   */
  @Post(':lineId/acknowledge')
  @RequirePermissions('inventory.consume')
  acknowledge(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.acknowledge(jobId, lineId, user);
  }

  @Post(':lineId/issue')
  @RequirePermissions('inventory.issue')
  issue(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: IssueJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.issue(
      jobId,
      lineId,
      { serial_no: dto.serial_no },
      user,
    );
  }

  @Post(':lineId/core-return')
  @RequirePermissions('inventory.core.return')
  returnCore(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: ReturnCoreDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.returnCore(
      jobId,
      lineId,
      {
        core_serial_no: dto.core_serial_no,
        bin_location: dto.bin_location,
        note: dto.note,
      },
      user,
    );
  }

  @Post('consume')
  @RequirePermissions('inventory.consume')
  consumeAll(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire[]> {
    return this.jobParts.consumeAll(jobId, user);
  }

  @Post(':lineId/consume')
  @RequirePermissions('inventory.consume')
  consume(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.consumeLine(jobId, lineId, user);
  }

  @Delete(':lineId')
  @RequirePermissions('inventory.reserve')
  remove(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ removed: true }> {
    return this.jobParts.remove(jobId, lineId, user);
  }
}
