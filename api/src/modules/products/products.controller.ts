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
  CreateProductDto,
  ProductListQueryDto,
  UpdateProductDto,
} from './dto/product.dto';
import { ProductsService, type ProductWire } from './products.service';

/**
 * /api/v1/products (retail catalogue). Reuses the catalogue permissions:
 *   GET   /products?q=&type=&active=   'part.read'
 *   GET   /products/{id}               'part.read'
 *   POST  /products                    'part.manage'
 *   PATCH /products/{id}               'part.manage'
 */
@Controller('products')
@UseGuards(AuthGuard, PermissionsGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermissions('part.read')
  list(
    @Query() query: ProductListQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaginatedResponse<ProductWire>> {
    return this.products.list(query, user);
  }

  @Get(':id')
  @RequirePermissions('part.read')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ProductWire> {
    return this.products.get(id);
  }

  @Post()
  @RequirePermissions('part.manage')
  create(
    @Body() dto: CreateProductDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ProductWire> {
    return this.products.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('part.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ProductWire> {
    return this.products.update(id, dto, user);
  }
}
