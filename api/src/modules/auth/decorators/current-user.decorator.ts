import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../auth.types';

/**
 * Injects the {@link AuthUser} attached by {@link AuthGuard}:
 *
 *   @UseGuards(AuthGuard)
 *   @Get('me')
 *   me(@CurrentUser() user: AuthUser) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: AuthUser }>();
    return request.user;
  },
);
