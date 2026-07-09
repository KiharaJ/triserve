import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { AccessTokenPayload, AuthUser } from '../auth.types';

/**
 * Validates the `Authorization: Bearer <access_token>` header and attaches
 * an {@link AuthUser} to `request.user`. Rejects refresh/mfa tokens (wrong
 * secret or wrong `type` claim). Read the user via `@CurrentUser()`.
 *
 * Authorization (permission matrix, branch scoping) is Task 0.3+ — this
 * guard only authenticates.
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

    request.user = {
      userId: payload.sub,
      sessionId: payload.sid,
      companyId: payload.companyId,
      role: payload.role,
      scope: payload.scope,
      homeBranchId: payload.homeBranchId,
    };
    return true;
  }
}
