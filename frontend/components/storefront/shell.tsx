import { type ReactNode } from 'react'
import { StorefrontHeader } from '@/components/layout/storefront/header'
import { StorefrontFooter } from '@/components/layout/storefront/footer'
import { StorefrontBottomNav } from '@/components/layout/storefront/bottom-nav'

export function StorefrontShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <StorefrontHeader />
      {/* pb-16 reserves space for the mobile bottom nav; cleared at md+ */}
      <main className="flex-1 pb-16 md:pb-0">{children}</main>
      <StorefrontFooter />
      <StorefrontBottomNav />
    </div>
  )
}
