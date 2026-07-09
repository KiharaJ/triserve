import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  CurrenciesController,
  FaultCodesController,
  PaymentMethodsController,
  RepairActionsController,
  TaxRatesController,
} from './config-tables.controller';
import { ConfigTablesService } from './config-tables.service';

/**
 * ConfigTablesModule — Task 0.7 (§4.14 / E17): CRUD for the per-company
 * config tables (payment methods, fault codes, repair actions, tax rates,
 * currencies). Named to avoid clashing with @nestjs/config's ConfigModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [
    PaymentMethodsController,
    FaultCodesController,
    RepairActionsController,
    TaxRatesController,
    CurrenciesController,
  ],
  providers: [ConfigTablesService],
  exports: [ConfigTablesService],
})
export class ConfigTablesModule {}
