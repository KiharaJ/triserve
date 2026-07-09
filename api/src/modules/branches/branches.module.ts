import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

/**
 * BranchesModule — Task 0.7: branch admin CRUD (/api/v1/branches) for the
 * company & branch admin screens.
 */
@Module({
  imports: [AuthModule],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
