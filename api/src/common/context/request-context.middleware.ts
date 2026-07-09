import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

/**
 * Enters a fresh AsyncLocalStorage store for every HTTP request.
 * Registered globally in AppModule so it runs BEFORE guards; AuthGuard
 * then populates the store's `user` after verifying the access token.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithRequestContext({}, () => next());
  }
}
