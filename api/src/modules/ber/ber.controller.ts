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
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthGuard } from '../auth/guards/auth.guard';
import {
  BerService,
  type BerAssessmentWire,
  type CertifyResult,
  type EvaluateResult,
} from './ber.service';
import {
  BerListQueryDto,
  BerOutcomeDto,
  CertifyBerDto,
  EvaluateBerDto,
  ExecuteSwapDto,
  RejectBerDto,
  SwapUnitListQueryDto,
  UpsertSwapUnitDto,
} from './dto/ber.dto';
import {
  SwapService,
  type DeviceSwapWire,
  type ExecuteSwapResult,
  type SwapUnitWire,
} from './swap.service';

/**
 * /api/v1 — Beyond Economic Repair & replacement (SCMS proposal Module 4, §5).
 *
 *   POST /jobs/{id}/ber/evaluate    'job.ber.evaluate'  run the 70% formula
 *   GET  /ber                       'job.read'          the review queue
 *   GET  /ber/{id}                  'job.read'
 *   POST /ber/{id}/certify          'job.ber.certify'   supervisor certifies
 *   POST /ber/{id}/reject           'job.ber.certify'   back on the repair track
 *   POST /ber/{id}/outcome          'job.ber.certify'   customer's decision
 *   GET  /ber/{id}/certificate      'job.read'          printable certificate
 *
 *   GET/POST/DELETE /swap-stock     'swapstock.read' / 'swapstock.manage'
 *   POST /jobs/{id}/swap            'job.swap.execute'  issue + realign identity
 *   GET  /jobs/{id}/swaps           'job.read'
 */
@Controller()
@UseGuards(AuthGuard, PermissionsGuard)
export class BerController {
  constructor(
    private readonly ber: BerService,
    private readonly swap: SwapService,
  ) {}

  // ---------------------------------------------------------------- BER

  @Post('jobs/:id/ber/evaluate')
  @RequirePermissions('job.ber.evaluate')
  @HttpCode(HttpStatus.OK)
  evaluate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EvaluateBerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<EvaluateResult> {
    return this.ber.evaluate(id, dto, user);
  }

  @Get('ber')
  @RequirePermissions('job.read')
  list(
    @Query() query: BerListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<BerAssessmentWire>> {
    return this.ber.list(query, user);
  }

  @Get('ber/:id')
  @RequirePermissions('job.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BerAssessmentWire> {
    return this.ber.get(id);
  }

  @Post('ber/:id/certify')
  @RequirePermissions('job.ber.certify')
  @HttpCode(HttpStatus.OK)
  certify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CertifyBerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CertifyResult> {
    return this.ber.certify(id, dto, user);
  }

  @Post('ber/:id/reject')
  @RequirePermissions('job.ber.certify')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectBerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BerAssessmentWire> {
    return this.ber.reject(id, dto, user);
  }

  @Post('ber/:id/outcome')
  @RequirePermissions('job.ber.certify')
  @HttpCode(HttpStatus.OK)
  outcome(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BerOutcomeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BerAssessmentWire> {
    return this.ber.recordOutcome(id, dto, user);
  }

  @Get('ber/:id/certificate')
  @RequirePermissions('job.read')
  certificate(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    return this.ber.certificate(id);
  }

  // -------------------------------------------------------- swap stock

  @Get('swap-stock')
  @RequirePermissions('swapstock.read')
  listUnits(
    @Query() query: SwapUnitListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<SwapUnitWire>> {
    return this.swap.listUnits(query, user);
  }

  @Post('swap-stock')
  @RequirePermissions('swapstock.manage')
  addUnit(
    @Body() dto: UpsertSwapUnitDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SwapUnitWire> {
    return this.swap.addUnit(dto, user);
  }

  @Delete('swap-stock/:id')
  @RequirePermissions('swapstock.manage')
  retireUnit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SwapUnitWire> {
    return this.swap.retireUnit(id, user);
  }

  @Post('jobs/:id/swap')
  @RequirePermissions('job.swap.execute')
  @HttpCode(HttpStatus.OK)
  executeSwap(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExecuteSwapDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ExecuteSwapResult> {
    return this.swap.execute(id, dto, user);
  }

  @Get('jobs/:id/swaps')
  @RequirePermissions('job.read')
  listSwaps(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<DeviceSwapWire[]> {
    return this.swap.listForJob(id, user);
  }
}
