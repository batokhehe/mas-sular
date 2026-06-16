import { type ReactNode } from 'react'
import { StorefrontHeader } from '@/components/layout/storefront/header'
import { StorefrontFooter } from '@/components/layout/storefront/footer'

export function StorefrontShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <StorefrontHeader />
      <main className="flex-1">{children}</main>
      <StorefrontFooter />
    </div>
  )
}
