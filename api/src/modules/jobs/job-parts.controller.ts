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

  @Post()
  @RequirePermissions('inventory.reserve')
  add(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Body() dto: AddJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.add(
      jobId,
      {
        part_id: dto.part_id,
        qty: dto.qty,
        unit_sell_price: dto.unit_sell_price,
        is_warranty: dto.is_warranty,
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

  @Post(':lineId/issue')
  @RequirePermissions('inventory.issue')
  issue(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: IssueJobPartDto,
    @CurrentUser() user: AuthUser,
  ): Promise<JobPartWire> {
    return this.jobParts.issue(jobId, lineId, { serial_no: dto.serial_no }, user);
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
