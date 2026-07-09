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
import { DevicesService, type DeviceWire } from '../devices/devices.service';
import { CustomersService, type CustomerWire } from './customers.service';
import {
  CreateCustomerDto,
  CustomerListQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

/**
 * /api/v1/customers (Task 1.1, DESIGN.md §4.2 / E2).
 *
 *   GET   /customers?q=&branch_id=&page=&page_size=  'customer.read'
 *   GET   /customers/{id}                            'customer.read'
 *   GET   /customers/{id}/devices                    'customer.read' + 'device.read'
 *   POST  /customers                                 'customer.create'
 *   PATCH /customers/{id}                            'customer.update'
 *
 * No DELETE: customers are CRM history anchors (jobs/invoices reference
 * them); soft-delete arrives with a dedicated flow later. Company-scoped —
 * deliberately NOT branch-scoped (see company-scope.extension.ts).
 */
@Controller('customers')
@UseGuards(AuthGuard, PermissionsGuard)
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly devices: DevicesService,
  ) {}

  @Get()
  @RequirePermissions('customer.read')
  list(
    @Query() query: CustomerListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<CustomerWire>> {
    return this.customers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('customer.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerWire> {
    return this.customers.get(id);
  }

  @Get(':id/devices')
  @RequirePermissions('customer.read', 'device.read')
  async listDevices(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<DeviceWire>> {
    await this.customers.getRow(id); // clean 404 for unknown/foreign ids
    return this.devices.listForCustomer(id, user);
  }

  @Post()
  @RequirePermissions('customer.create')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomerWire> {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('customer.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomerWire> {
    return this.customers.update(id, dto, user);
  }
}
