import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import type { AuthTokensResponse } from '@/lib/types'
import {
  clearTokens,
  getAccessToken,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from '@/lib/tokens'

/**
 * Axios client for the TriServe API (Task 0.7).
 *
 * Base URL defaults to /api/v1 — in dev the Vite server proxies /api to the
 * NestJS backend (see vite.config.ts). Override with VITE_API_BASE_URL.
 *
 * Auth plumbing:
 *  - request interceptor attaches the in-memory access token;
 *  - response interceptor: on 401 (outside the auth endpoints) it runs ONE
 *    single-flight POST /auth/refresh (rotating the stored refresh token),
 *    then retries the failed request once. If the refresh itself fails the
 *    tokens are cleared and 'triserve:unauthorized' is dispatched so the
 *    auth provider can drop to the login screen.
 */

const BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

export const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

/** Endpoints whose 401s must NOT trigger a token refresh loop. */
const NO_REFRESH_PATHS = ['/auth/login', '/auth/login/verify', '/auth/refresh']

/** Fired when a refresh fails — the session is over. */
export const UNAUTHORIZED_EVENT = 'triserve:unauthorized'

let refreshInFlight: Promise<AuthTokensResponse | null> | null = null

/**
 * Rotate tokens via POST /auth/refresh (single-flight: concurrent 401s all
 * await the same request). Uses a BARE axios call so this never recurses
 * through the interceptors. Returns null when there is no refresh token or
 * the API rejected it (session revoked/expired).
 */
export function refreshTokens(): Promise<AuthTokensResponse | null> {
  refreshInFlight ??= (async () => {
    const refreshToken = getRefreshToken()
    if (!refreshToken) return null
    try {
      const res = await axios.post<AuthTokensResponse>(
        `${BASE_URL}/auth/refresh`,
        { refresh_token: refreshToken },
      )
      setAccessToken(res.data.access_token)
      setRefreshToken(res.data.refresh_token)
      return res.data
    } catch {
      clearTokens()
      return null
    }
  })().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

api.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

interface RetriableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean
}

api.interceptors.response.use(undefined, async (error: AxiosError) => {
  const config = error.config as RetriableConfig | undefined
  const status = error.response?.status
  const url = config?.url ?? ''

  const refreshable =
    status === 401 &&
    config !== undefined &&
    !config._retried &&
    !NO_REFRESH_PATHS.some((p) => url.includes(p))

  if (!refreshable) throw error

  config._retried = true
  const tokens = await refreshTokens()
  if (!tokens) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    throw error
  }
  config.headers.Authorization = `Bearer ${tokens.access_token}`
  return api(config)
})

/** Standard `{error:{code,message}}` body → human message for toasts. */
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as
      | { error?: { message?: string; details?: unknown } }
      | undefined
    const details = body?.error?.details
    if (Array.isArray(details) && details.length > 0) {
      return String(details[0])
    }
    if (body?.error?.message) return body.error.message
    if (error.response === undefined) return 'API unreachable'
  }
  return 'Something went wrong'
}
