'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, UtensilsCrossed, ShoppingCart, ClipboardList, User } from 'lucide-react'
import { useCartStore, cartCount } from '@/lib/stores/cart-store'
import { cn } from '@/lib/utils'

// Mobile-only bottom navigation. Routes are the canonical production routes;
// auth-gated targets (/orders, /account) are handled by their existing route guards.
const ITEMS = [
  { href: '/', icon: Home, label: 'Home' },
  { href: '/catalog', icon: UtensilsCrossed, label: 'Catalog' },
  { href: '/cart', icon: ShoppingCart, label: 'Cart' },
  { href: '/orders', icon: ClipboardList, label: 'Orders' },
  { href: '/account/addresses', icon: User, label: 'Account' },
]

export function StorefrontBottomNav() {
  const pathname = usePathname()
  const count = useCartStore((s) => cartCount(s.lines))

  // Hidden on auth/onboarding (and never used by the admin shell).
  if (pathname?.startsWith('/login') || pathname?.startsWith('/onboarding')) return null

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
      <div className="flex h-16 items-center justify-around px-2">
        {ITEMS.map((item) => {
          const Icon = item.icon
          const active = pathname === item.href || (item.href !== '/' && pathname?.startsWith(item.href))
          const showBadge = item.href === '/cart' && count > 0
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'relative flex h-full w-16 flex-col items-center justify-center gap-1 transition-colors',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <span className="relative">
                <Icon className="size-5" />
                {showBadge ? (
                  <span className="absolute -right-2 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                    {count > 9 ? '9+' : count}
                  </span>
                ) : null}
              </span>
              <span className="text-[10px] font-medium">{item.label}</span>
              {active ? <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-primary" /> : null}
            </Link>
          )
        })}
      </div>
      <div className="h-[env(safe-area-inset-bottom)]" />
    </nav>
  )
}
