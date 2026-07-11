import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * SuppliersModule — Task 2.5 (§4.4b): the parts-vendor master (/api/v1/
 * suppliers). Exported so the procurement chain (POs → GRN, Tasks 2.6/2.7)
 * and reorder suggestions can resolve + rank suppliers.
 */
@Module({
  imports: [AuthModule],
  controllers: [SuppliersController],
  providers: [SuppliersService],
  exports: [SuppliersService],
})
export class SuppliersModule {}
