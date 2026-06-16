'use client'

import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { authApi } from '@/lib/api/auth.api'
import { qk } from '@/lib/query/keys'
import type { User } from '@/lib/types/models'
import {
  setCustomerTokens,
  clearCustomerTokens,
  setAdminToken,
  clearAdminToken,
  hasCustomerSession,
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
      setCustomerTokens(res.accessToken, res.refreshToken)
      await qc.invalidateQueries({ queryKey: qk.me })
    },
    [qc],
  )

  const logout = useCallback(() => {
    clearCustomerTokens()
    qc.removeQueries({ queryKey: qk.me })
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
