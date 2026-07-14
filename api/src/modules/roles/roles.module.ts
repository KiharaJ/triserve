import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * RolesModule (E17) — the roles admin surface (/api/v1/roles). The resolver it
 * edits is provided globally by {@link PermissionResolverModule}, so this
 * module only wires the controller/service and pulls in AuthModule for guards.
 */
@Module({
  imports: [AuthModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}
