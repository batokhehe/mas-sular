'use client'

import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi } from '@/lib/api/auth.api'
import { qk } from '@/lib/query/keys'
import type { User } from '@/lib/types/models'
import {
  setAdminToken,
  clearAdminToken,
  hasCustomerSession,
  removeLegacyCustomerCookies,
} from './tokens'

interface AuthContextValue {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  loginWithGoogle: (idToken: string) => Promise<void>
  logout: () => void
  adminLogin: (email: string, password: string) => Promise<void>
  adminLogout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: authApi.me,
    enabled: hasCustomerSession(),
    retry: false,
    staleTime: 5 * 60_000,
  })

  const loginWithGoogle = useCallback(
    async (idToken: string) => {
      const res = await authApi.googleLogin(idToken)
      // Phase 13B.3: the backend sets the customer session via httpOnly cookies
      // (ms_access/ms_refresh) and the ms_session marker on this response — the
      // client no longer stores tokens. Remove any legacy host-only token cookies
      // to avoid duplicate same-named cookies.
      removeLegacyCustomerCookies()
      // Seed the cache from the login response so `meQuery` updates immediately.
      // `invalidateQueries` alone does NOT refetch `me` here: it is disabled
      // (enabled: hasCustomerSession() was false at render and the marker cookie
      // does not re-render the provider), so without this the UI would only
      // reflect the login after a reload.
      qc.setQueryData(qk.me, res.user)
      await qc.invalidateQueries({ queryKey: qk.me })
    },
    [qc],
  )

  const logout = useCallback(async () => {
    // Phase 13B.5: terminate the SERVER session — backend /auth/logout revokes the
    // presented refresh token and clears httpOnly ms_access/ms_refresh + the
    // ms_session marker. Best-effort: a failed backend call must NOT block logout,
    // so local cleanup always runs afterward.
    await authApi.logout().catch(() => undefined)
    removeLegacyCustomerCookies()
    qc.removeQueries({ queryKey: qk.me })
    qc.setQueryData(qk.me, null)
  }, [qc])

  const adminLogin = useCallback(
    async (email: string, password: string) => {
      const res = await authApi.adminLogin(email, password)
      setAdminToken(res.accessToken)
      await qc.invalidateQueries({ queryKey: qk.admin.me })
    },
    [qc],
  )

  const adminLogout = useCallback(async () => {
    try {
      await authApi.adminLogout()
    } catch {
      // best-effort
    }
    clearAdminToken()
    qc.removeQueries({ queryKey: qk.admin.me })
  }, [qc])

  const value: AuthContextValue = {
    user: meQuery.data ?? null,
    isAuthenticated: !!meQuery.data,
    isLoading: meQuery.isLoading,
    loginWithGoogle,
    logout,
    adminLogin,
    adminLogout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
