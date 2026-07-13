import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  CreateWarrantyRegistrationDto,
  UpdateWarrantyRegistrationDto,
  WarrantyRegistrationListQueryDto,
} from './dto/warranty-registration.dto';
import {
  WarrantyRegistrationsService,
  type WarrantyRegistrationWire,
} from './warranty-registrations.service';

/**
 * /api/v1/warranty-registrations (retail) — warranties issued on sold products.
 *
 *   GET   /warranty-registrations?status=&kind=&customer_id=&q=  'customer.read'
 *   GET   /warranty-registrations/lookup?serial=                 'customer.read'
 *   GET   /warranty-registrations/{id}                           'customer.read'
 *   POST  /warranty-registrations                                'invoice.create'
 *   PATCH /warranty-registrations/{id}                           'invoice.create'
 *
 * Company- AND branch-scoped. Gated by the sell/read permissions the front desk
 * already holds — no new permission needed.
 */
@Controller('warranty-registrations')
@UseGuards(AuthGuard, PermissionsGuard)
export class WarrantyRegistrationsController {
  constructor(private readonly registrations: WarrantyRegistrationsService) {}

  @Get()
  @RequirePermissions('customer.read')
  list(
    @Query() query: WarrantyRegistrationListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<WarrantyRegistrationWire>> {
    return this.registrations.list(query, user);
  }

  /** Point-of-repair check: is this serial/IMEI under warranty? */
  @Get('lookup')
  @RequirePermissions('customer.read')
  lookup(
    @Query('serial') serial: string,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyRegistrationWire | null> {
    return this.registrations.lookup(serial ?? '', user);
  }

  @Get(':id')
  @RequirePermissions('customer.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WarrantyRegistrationWire> {
    return this.registrations.get(id);
  }

  @Post()
  @RequirePermissions('invoice.create')
  create(
    @Body() dto: CreateWarrantyRegistrationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyRegistrationWire> {
    return this.registrations.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('invoice.create')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWarrantyRegistrationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<WarrantyRegistrationWire> {
    return this.registrations.update(id, dto, user);
  }
}
