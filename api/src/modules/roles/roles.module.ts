import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RoleLimitsService } from './role-limits.service';
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
  providers: [RolesService, RoleLimitsService],
  // SCMS proposal Module 5: POS/job code checks a user's ceiling before
  // letting a discount, adjustment or write-off through.
  exports: [RoleLimitsService],
})
export class RolesModule {}
