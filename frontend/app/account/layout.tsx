import { type ReactNode } from 'react'
import { RequireAuth } from '@/components/auth/require-auth'
import { StorefrontShell } from '@/components/storefront/shell'

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAuth>
      <StorefrontShell>{children}</StorefrontShell>
    </RequireAuth>
  )
}
