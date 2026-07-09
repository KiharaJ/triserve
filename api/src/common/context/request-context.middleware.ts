import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

/**
 * Enters a fresh AsyncLocalStorage store for every HTTP request.
 * Registered globally in AppModule so it runs BEFORE guards; AuthGuard
 * then populates the store's `user` after verifying the access token.
 *
 * Task 0.4: the store is seeded with the client IP + User-Agent so the
 * audit extension can stamp them onto audit_log rows without needing the
 * Express request threaded through services.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    runWithRequestContext(
      { ip: req.ip, userAgent: req.headers['user-agent'] },
      () => next(),
    );
  }
}
