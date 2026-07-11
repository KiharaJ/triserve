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
  CreateSupplierDto,
  SupplierListQueryDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';
import { SuppliersService, type SupplierWire } from './suppliers.service';

/**
 * /api/v1/suppliers (Task 2.5, DESIGN.md §4.4b) — the parts-vendor master.
 *
 *   GET   /suppliers?active=&q=&page=   'supplier.read'
 *   GET   /suppliers/{id}               'supplier.read'
 *   POST  /suppliers                    'supplier.manage'
 *   PATCH /suppliers/{id}               'supplier.manage'
 *
 * Company-scoped, company-level config (like parts). No DELETE — suppliers
 * carry procurement history; deactivate via `active`.
 */
@Controller('suppliers')
@UseGuards(AuthGuard, PermissionsGuard)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermissions('supplier.read')
  list(
    @Query() query: SupplierListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<SupplierWire>> {
    return this.suppliers.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('supplier.read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplierWire> {
    return this.suppliers.get(id, user);
  }

  @Post()
  @RequirePermissions('supplier.manage')
  create(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplierWire> {
    return this.suppliers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('supplier.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SupplierWire> {
    return this.suppliers.update(id, dto, user);
  }
}
