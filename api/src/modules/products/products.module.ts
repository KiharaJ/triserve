import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

/**
 * ProductsModule (retail catalogue) — the electronics the shop sells, separate
 * from the Samsung repair `parts`. Company-scoped; reuses the catalogue
 * permissions (part.read / part.manage).
 */
@Module({
  imports: [AuthModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
