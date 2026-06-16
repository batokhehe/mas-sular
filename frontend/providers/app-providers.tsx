'use client'

import { type ReactNode } from 'react'
import { Toaster } from 'sonner'
import { QueryProvider } from './query-provider'
import { AuthProvider } from '@/lib/auth/auth-context'

/**
 * Canonical foundation provider stack for spec-aligned route groups:
 * TanStack Query (with global error handling) + customer AuthProvider + Toaster.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>
        {children}
        <Toaster position="top-center" richColors />
      </AuthProvider>
    </QueryProvider>
  )
}
