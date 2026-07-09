/**
 * @triserve/shared — shared TypeScript types/enums used by both
 * @triserve/api and @triserve/web.
 *
 * Ships the cross-cutting API envelope contracts (Task 0.0) and the
 * permission matrix (Task 0.3 / E18). Domain types/enums are added by
 * later tasks.
 */

export * from './permissions';

/** Standard envelope returned by every list endpoint. */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

/** Standard query parameters accepted by every list endpoint. */
export interface ListQueryParams {
  page?: number;
  page_size?: number;
  q?: string;
}

/** Consistent JSON error shape returned by the API's global exception filter. */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  error: ApiErrorBody;
}

/** Response of GET /api/v1/health. */
export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  time: string;
  /** DB connectivity probe result ('up' | 'down'). */
  db: 'up' | 'down';
}
