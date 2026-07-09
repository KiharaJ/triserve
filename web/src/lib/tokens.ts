/**
 * Token store (Task 0.7).
 *
 * - ACCESS token lives in memory only (module variable): it is short-lived
 *   (15 min) and keeping it out of storage removes the XSS-exfiltration
 *   easy path.
 * - REFRESH token is persisted to localStorage so a reload keeps the user
 *   signed in; it is rotated on every /auth/refresh, and the API stores
 *   only its hash server-side (revocable per session).
 */

const REFRESH_TOKEN_KEY = 'triserve.refresh_token'

let accessToken: string | null = null

export function getAccessToken(): string | null {
  return accessToken
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setRefreshToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(REFRESH_TOKEN_KEY)
    else localStorage.setItem(REFRESH_TOKEN_KEY, token)
  } catch {
    // Storage unavailable (private mode etc.) — session won't survive reload.
  }
}

export function clearTokens(): void {
  setAccessToken(null)
  setRefreshToken(null)
}
