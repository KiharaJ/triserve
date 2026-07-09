import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorResponse } from '@triserve/shared';
import type { Response } from 'express';
import { MulterError } from 'multer';

/**
 * Global exception filter: every error leaves the API as
 *   { error: { code, message, details } }
 *
 * - `code`: stable machine-readable string (HTTP status name, e.g. NOT_FOUND)
 * - `message`: human-readable summary
 * - `details`: optional extra info (e.g. class-validator constraint messages)
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        if (Array.isArray(b.message)) {
          // class-validator errors arrive as string[]
          message = 'Validation failed';
          details = b.message;
        } else if (typeof b.message === 'string') {
          message = b.message;
        } else {
          message = exception.message;
        }
      }
    } else if (exception instanceof MulterError) {
      // Task 1.4 (§4.12): multer's OWN limits.fileSize is a memory backstop
      // (see MULTER_HARD_CEILING_BYTES) — the real, configurable upload cap
      // is enforced as a normal HttpException in AttachmentsService. This
      // branch only guards against ever surfacing that backstop as a bare
      // 500; any multipart upload feature benefits from it.
      status =
        exception.code === 'LIMIT_FILE_SIZE'
          ? HttpStatus.PAYLOAD_TOO_LARGE
          : HttpStatus.BAD_REQUEST;
      message = exception.message;
    } else {
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const payload: ApiErrorResponse = {
      error: {
        code: HttpStatus[status] ?? 'INTERNAL_SERVER_ERROR',
        message,
        ...(details !== undefined ? { details } : {}),
      },
    };

    response.status(status).json(payload);
  }
}
