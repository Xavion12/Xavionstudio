import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { clearApiCache } from '@/hooks/useApi'
import { onPasswordChangeRequired, onUnauthorized } from '@/services/api'
import { authApi } from '@/services/endpoints'
import type { AuthResponse, Role, User } from '@/types'
import { KEYS, readJSON, writeJSON, writeStorage } from '@/utils/storage'

// Sessions from before the cookie change kept the token in localStorage: remove it for good.
writeStorage(KEYS.legacyToken, null)

interface AuthValue {
  user: User | null
  /** true once the stored session has been checked with the server (or there was none) */
  verified: boolean
  sessionExpired: boolean
  login: (identifier: string, password: string, remember: boolean) => Promise<User>
  applySession: (auth: AuthResponse) => void
  logout: () => void
  hasRole: (...roles: Role[]) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

export function homePathFor(user: User | null): string {
  if (!user) return '/login'
  if (user.must_change_password) return '/account/password'
  if (user.role === 'MEMBER') return '/portal'
  if (user.role === 'TRAINER') return '/trainer'
  return '/dashboard'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // The session itself is an HttpOnly cookie; the cached user only lets the UI render at once
  // and is confirmed with /auth/me below.
  const [user, setUser] = useState<User | null>(() => readJSON<User>(KEYS.user))
  const [verified, setVerified] = useState(() => !readJSON<User>(KEYS.user))
  const [sessionExpired, setSessionExpired] = useState(false)

  const clearSession = useCallback((expired: boolean) => {
    writeStorage(KEYS.user, null)
    writeStorage(KEYS.memberQr, null)
    clearApiCache()
    setUser(null)
    setSessionExpired(expired)
    setVerified(true)
  }, [])

  const applySession = useCallback((auth: AuthResponse) => {
    writeJSON(KEYS.user, auth.user)
    clearApiCache()
    setSessionExpired(false)
    setUser(auth.user)
    setVerified(true)
  }, [])

  useEffect(() => {
    onUnauthorized(() => clearSession(true))
    onPasswordChangeRequired(() =>
      setUser((current) => {
        if (!current) return current
        const next = { ...current, must_change_password: true }
        writeJSON(KEYS.user, next)
        return next
      }),
    )
  }, [clearSession])

  // Revalidate a stored session in the background; the UI renders immediately from cache.
  useEffect(() => {
    if (!readJSON<User>(KEYS.user)) return
    authApi
      .me()
      .then((fresh) => {
        writeJSON(KEYS.user, fresh)
        setUser(fresh)
      })
      .catch(() => undefined) // 401 is handled by onUnauthorized; offline keeps the cached session
      .finally(() => setVerified(true))
  }, [])

  const login = useCallback(
    async (identifier: string, password: string, remember: boolean) => {
      const auth = await authApi.login(identifier, password, remember)
      applySession(auth)
      return auth.user
    },
    [applySession],
  )

  const logout = useCallback(() => {
    clearSession(false)
    authApi.logout().catch(() => undefined) // clears the cookie; offline, it simply expires
  }, [clearSession])
  const hasRole = useCallback((...roles: Role[]) => !!user && roles.includes(user.role), [user])

  const value = useMemo(
    () => ({ user, verified, sessionExpired, login, applySession, logout, hasRole }),
    [user, verified, sessionExpired, login, applySession, logout, hasRole],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
