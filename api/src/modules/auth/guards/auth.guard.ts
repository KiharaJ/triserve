import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { setCurrentUser } from '../../../common/context/request-context';
import type { AccessTokenPayload, AuthUser } from '../auth.types';

/**
 * Validates the `Authorization: Bearer <access_token>` header and attaches
 * an {@link AuthUser} to `request.user` AND to the AsyncLocalStorage request
 * context (Task 0.3) so the Prisma company-scope extension can see the
 * acting user. Rejects refresh/mfa tokens (wrong secret or wrong `type`
 * claim). Read the user via `@CurrentUser()`.
 *
 * Permission checks live in {@link PermissionsGuard} — list this guard
 * first: `@UseGuards(AuthGuard, PermissionsGuard)`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();

    const header = request.headers.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing access token');
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    const user: AuthUser = {
      userId: payload.sub,
      sessionId: payload.sid,
      companyId: payload.companyId,
      role: payload.role,
      scope: payload.scope,
      homeBranchId: payload.homeBranchId,
    };
    request.user = user;
    // Expose the acting user to the ALS request context so the Prisma
    // company-scope extension applies tenancy filters (Task 0.3).
    setCurrentUser(user);
    return true;
  }
}
