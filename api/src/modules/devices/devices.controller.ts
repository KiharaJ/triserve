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
import { DevicesService, type DeviceWire } from './devices.service';
import {
  CreateDeviceDto,
  DeviceListQueryDto,
  UpdateDeviceDto,
} from './dto/device.dto';

/**
 * /api/v1/devices (Task 1.1, DESIGN.md §4.2 / E3).
 *
 *   GET   /devices?imei=&customer_id=&page=&page_size=  'device.read'
 *   GET   /devices/{id}                                 'device.read'
 *   POST  /devices                                      'device.create'
 *   PATCH /devices/{id}                                 'device.update'
 *
 * No DELETE: devices anchor the E3 history timeline. Company-scoped —
 * deliberately NOT branch-scoped (see company-scope.extension.ts).
 */
@Controller('devices')
@UseGuards(AuthGuard, PermissionsGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermissions('device.read')
  list(
    @Query() query: DeviceListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<DeviceWire>> {
    return this.devices.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('device.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<DeviceWire> {
    return this.devices.get(id);
  }

  @Post()
  @RequirePermissions('device.create')
  create(
    @Body() dto: CreateDeviceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<DeviceWire> {
    return this.devices.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('device.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeviceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<DeviceWire> {
    return this.devices.update(id, dto, user);
  }
}
