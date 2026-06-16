'use client'

import { type ReactNode } from 'react'
import { QueryProvider } from '@/providers/query-provider'
import { AuthProvider } from '@/lib/auth/auth-context'

// Foundation provider stack (Phase 9A): TanStack Query with global error
// handling + customer AuthProvider. The Toaster + ThemeProvider stay in the
// root layout.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider>{children}</AuthProvider>
    </QueryProvider>
  )
}
