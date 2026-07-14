import { Global, Module } from '@nestjs/common';
import { PermissionResolverService } from './permission-resolver.service';

/**
 * Global so the {@link PermissionsGuard} — instantiated per-controller across
 * every feature module — and {@link AuthService} can inject the resolver
 * without each module importing it (E17). Kept separate from RolesModule (the
 * admin controller/service) to avoid a cycle: AuthModule consumes the resolver
 * while RolesModule imports AuthModule for its guards.
 */
@Global()
@Module({
  providers: [PermissionResolverService],
  exports: [PermissionResolverService],
})
export class PermissionResolverModule {}
