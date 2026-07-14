import type { Permission } from '@triserve/shared';
import type { UserRole, UserScope } from '@prisma/client';

/**
 * Shared auth types (Task 0.2 / E18).
 *
 * Three JWT kinds, distinguished by a `type` claim so one can never be
 * accepted in place of another:
 *   - access  — 15 min, signed with JWT_ACCESS_SECRET
 *   - refresh — 7 d,   signed with JWT_REFRESH_SECRET, hash stored per session
 *   - mfa     — 5 min, signed with JWT_ACCESS_SECRET, only accepted by
 *               POST /auth/login/verify
 */
export type TokenType = 'access' | 'refresh' | 'mfa';

export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  companyId: string;
  role: UserRole;
  scope: UserScope;
  homeBranchId: string | null;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  /** Unique per issued token — guarantees rotation always changes the hash. */
  jti: string;
  type: 'refresh';
}

export interface MfaTokenPayload {
  sub: string;
  type: 'mfa';
}

/** Attached to `request.user` by {@link AuthGuard}; read via `@CurrentUser()`. */
export interface AuthUser {
  userId: string;
  sessionId: string;
  companyId: string;
  role: UserRole;
  scope: UserScope;
  homeBranchId: string | null;
}

/** Sanitized user returned by login/verify and GET /me (snake_case wire format). */
export interface PublicUser {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  scope: UserScope;
  company_id: string;
  home_branch_id: string | null;
  totp_enabled: boolean;
  /**
   * The user's EFFECTIVE permissions for their company (E17) — the static
   * role defaults with the company's overrides applied. The web app gates its
   * UI on this list; the API re-checks server-side on every endpoint.
   */
  permissions: Permission[];
}

/**
 * One row of GET /auth/sessions (Task 0.7): device/login history for the
 * security screen. `current` marks the session behind the presented access
 * token. Refresh-token hashes never leave the API.
 */
export interface SessionEntry {
  id: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string;
  revoked_at: string | null;
  current: boolean;
}

export interface AuthTokensResponse {
  access_token: string;
  refresh_token: string;
  user: PublicUser;
}

export interface MfaRequiredResponse {
  mfa_required: true;
  mfa_token: string;
}

export type LoginResponse = AuthTokensResponse | MfaRequiredResponse;
