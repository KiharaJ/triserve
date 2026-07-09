import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModelsController } from './models.controller';
import { ModelsService } from './models.service';

/**
 * ModelsModule — Task 1.1 (§4.2): the device-model lookup (/api/v1/models),
 * company-level config normalising the free-text model column.
 */
@Module({
  imports: [AuthModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
