import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { roleHasPermission, type Permission } from '@triserve/shared'
import { api, refreshTokens, UNAUTHORIZED_EVENT } from '@/lib/api'
import {
  clearTokens,
  getRefreshToken,
  setAccessToken,
  setRefreshToken,
} from '@/lib/tokens'
import type {
  AuthTokensResponse,
  LoginResponse,
  PublicUser,
} from '@/lib/types'

/**
 * Auth context (Task 0.7): current user + login/2FA/logout, bootstrapped
 * from the persisted refresh token on load. Permission checks here are UX
 * ONLY (hide what a role can't reach) — the API enforces the same matrix
 * server-side on every endpoint.
 */

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

export type LoginResult =
  | { kind: 'ok' }
  | { kind: 'mfa_required'; mfa_token: string }

interface AuthContextValue {
  status: AuthStatus
  user: PublicUser | null
  login(email: string, password: string): Promise<LoginResult>
  verifyMfa(mfaToken: string, code: string): Promise<void>
  logout(): Promise<void>
  /** Re-fetch /me (e.g. after enabling/disabling 2FA). */
  refreshUser(): Promise<void>
  /** UX-only gate from the shared ROLE_PERMISSIONS matrix. */
  can(permission: Permission): boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

function isMfaRequired(
  res: LoginResponse,
): res is { mfa_required: true; mfa_token: string } {
  return 'mfa_required' in res && res.mfa_required
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<PublicUser | null>(null)

  const acceptTokens = useCallback((tokens: AuthTokensResponse) => {
    setAccessToken(tokens.access_token)
    setRefreshToken(tokens.refresh_token)
    setUser(tokens.user)
    setStatus('authenticated')
  }, [])

  const dropSession = useCallback(() => {
    clearTokens()
    setUser(null)
    setStatus('anonymous')
  }, [])

  // Bootstrap: a persisted refresh token silently restores the session.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!getRefreshToken()) {
        setStatus('anonymous')
        return
      }
      const tokens = await refreshTokens()
      if (cancelled) return
      if (tokens) acceptTokens(tokens)
      else dropSession()
    })()
    return () => {
      cancelled = true
    }
  }, [acceptTokens, dropSession])

  // A failed mid-session refresh (revoked/expired) ends the session.
  useEffect(() => {
    const onUnauthorized = () => dropSession()
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [dropSession])

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await api.post<LoginResponse>('/auth/login', {
        email,
        password,
      })
      if (isMfaRequired(res.data)) {
        return { kind: 'mfa_required', mfa_token: res.data.mfa_token }
      }
      acceptTokens(res.data)
      return { kind: 'ok' }
    },
    [acceptTokens],
  )

  const verifyMfa = useCallback(
    async (mfaToken: string, code: string): Promise<void> => {
      const res = await api.post<AuthTokensResponse>('/auth/login/verify', {
        mfa_token: mfaToken,
        code,
      })
      acceptTokens(res.data)
    },
    [acceptTokens],
  )

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post('/auth/logout')
    } catch {
      // Session may already be gone server-side — drop it locally anyway.
    }
    dropSession()
  }, [dropSession])

  const refreshUser = useCallback(async (): Promise<void> => {
    const res = await api.get<PublicUser>('/me')
    setUser(res.data)
  }, [])

  const can = useCallback(
    (permission: Permission): boolean => {
      if (!user) return false
      // Prefer the server-resolved effective set (E17: role defaults + this
      // company's overrides); fall back to the static matrix for sessions
      // issued before the field existed. UX-only — the API re-checks.
      if (user.permissions) return user.permissions.includes(permission)
      return roleHasPermission(user.role, permission)
    },
    [user],
  )

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, verifyMfa, logout, refreshUser, can }),
    [status, user, login, verifyMfa, logout, refreshUser, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
