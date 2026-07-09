import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';

/**
 * DevicesModule — Task 1.1 (§4.2/E3): device registry CRUD
 * (/api/v1/devices). Exports DevicesService for the customers module's
 * GET /customers/{id}/devices sub-resource.
 */
@Module({
  imports: [AuthModule],
  controllers: [DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
