import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ConfigTablesService,
  type CurrencyWire,
  type FaultCodeWire,
  type PaymentMethodWire,
  type RepairActionWire,
  type TaxRateWire,
} from './config-tables.service';
import {
  ConfigListQueryDto,
  CreateCurrencyDto,
  CreateFaultCodeDto,
  CreatePaymentMethodDto,
  CreateRepairActionDto,
  CreateTaxRateDto,
  UpdateCurrencyDto,
  UpdateFaultCodeDto,
  UpdatePaymentMethodDto,
  UpdateRepairActionDto,
  UpdateTaxRateDto,
} from './dto/config-tables.dto';

/**
 * Config-table CRUD endpoints (Task 0.7, DESIGN.md §4.14 / E17). One thin
 * controller per table, all with the same surface:
 *
 *   GET    /{table}?q=&active=&page=&page_size=   'config.read'
 *   POST   /{table}                               'config.manage'
 *   PATCH  /{table}/{id}                          'config.manage'
 *   DELETE /{table}/{id}   (soft delete, 204)     'config.manage'
 *
 * Company-scoped to the caller; every mutation is audited automatically.
 */

@Controller('payment-methods')
@UseGuards(AuthGuard, PermissionsGuard)
export class PaymentMethodsController {
  constructor(private readonly config: ConfigTablesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: ConfigListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<PaymentMethodWire>> {
    return this.config.listPaymentMethods(query, user);
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreatePaymentMethodDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentMethodWire> {
    return this.config.createPaymentMethod(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentMethodDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentMethodWire> {
    return this.config.updatePaymentMethod(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('config.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.config.removePaymentMethod(id, user);
  }
}

@Controller('fault-codes')
@UseGuards(AuthGuard, PermissionsGuard)
export class FaultCodesController {
  constructor(private readonly config: ConfigTablesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: ConfigListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<FaultCodeWire>> {
    return this.config.listFaultCodes(query, user);
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreateFaultCodeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<FaultCodeWire> {
    return this.config.createFaultCode(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFaultCodeDto,
    @CurrentUser() user: AuthUser,
  ): Promise<FaultCodeWire> {
    return this.config.updateFaultCode(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('config.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.config.removeFaultCode(id, user);
  }
}

@Controller('repair-actions')
@UseGuards(AuthGuard, PermissionsGuard)
export class RepairActionsController {
  constructor(private readonly config: ConfigTablesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: ConfigListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<RepairActionWire>> {
    return this.config.listRepairActions(query, user);
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreateRepairActionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RepairActionWire> {
    return this.config.createRepairAction(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRepairActionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RepairActionWire> {
    return this.config.updateRepairAction(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('config.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.config.removeRepairAction(id, user);
  }
}

@Controller('tax-rates')
@UseGuards(AuthGuard, PermissionsGuard)
export class TaxRatesController {
  constructor(private readonly config: ConfigTablesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: ConfigListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<TaxRateWire>> {
    return this.config.listTaxRates(query, user);
  }

  /**
   * Active tax rates for the POS (invoice VAT picker) — readable by anyone who
   * can raise an invoice, without the broader config.read grant.
   */
  @Get('active')
  @RequirePermissions('invoice.create')
  active(
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<TaxRateWire>> {
    return this.config.listTaxRates(
      { active: true, page_size: 100 } as ConfigListQueryDto,
      user,
    );
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreateTaxRateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaxRateWire> {
    return this.config.createTaxRate(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxRateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaxRateWire> {
    return this.config.updateTaxRate(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('config.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.config.removeTaxRate(id, user);
  }
}

@Controller('currencies')
@UseGuards(AuthGuard, PermissionsGuard)
export class CurrenciesController {
  constructor(private readonly config: ConfigTablesService) {}

  @Get()
  @RequirePermissions('config.read')
  list(
    @Query() query: ConfigListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<CurrencyWire>> {
    return this.config.listCurrencies(query, user);
  }

  @Post()
  @RequirePermissions('config.manage')
  create(
    @Body() dto: CreateCurrencyDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CurrencyWire> {
    return this.config.createCurrency(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('config.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCurrencyDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CurrencyWire> {
    return this.config.updateCurrency(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('config.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.config.removeCurrency(id, user);
  }
}
