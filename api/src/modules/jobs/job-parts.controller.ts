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
import { AddJobPartDto } from './dto/job-part.dto';
import { JobPartsService, type JobPartWire } from './job-parts.service';

/**
 * /api/v1/jobs/{jobId}/parts (Task 2.2, DESIGN.md §4.5) — parts on a job.
 *
 *   GET    /jobs/{jobId}/parts                    'job.read'
 *   POST   /jobs/{jobId}/parts        (reserve)   'inventory.reserve'
 *   DELETE /jobs/{jobId}/parts/{id}   (unreserve) 'inventory.reserve'
 *   POST   /jobs/{jobId}/parts/consume      (all) 'inventory.consume'
 *   POST   /jobs/{jobId}/parts/{id}/consume       'inventory.consume'
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
