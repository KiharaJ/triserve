import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesModule } from '../devices/devices.module';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

/**
 * CustomersModule — Task 1.1 (§4.2/E2): customer CRM CRUD
 * (/api/v1/customers) + the GET /customers/{id}/devices sub-resource
 * (via DevicesModule).
 */
@Module({
  imports: [AuthModule, DevicesModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
