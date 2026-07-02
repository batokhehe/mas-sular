'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, UtensilsCrossed, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StorefrontLink {
  label: string
  href: string
  icon: typeof Home
}

// Canonical production routes (catalog is the real listing — not the retired /menu).
export const STOREFRONT_LINKS: StorefrontLink[] = [
  { label: 'Home', href: '/', icon: Home },
  { label: 'Catalog', href: '/catalog', icon: UtensilsCrossed },
  { label: 'Orders', href: '/orders', icon: ClipboardList },
]

export function isActivePath(pathname: string | null, href: string): boolean {
  if (!pathname) return false
  return pathname === href || (href !== '/' && pathname.startsWith(href))
}

export function StorefrontNavigation() {
  const pathname = usePathname()
  return (
    <nav className="flex items-center gap-1">
      {STOREFRONT_LINKS.map((link) => {
        const active = isActivePath(pathname, link.href)
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              'relative rounded-lg px-4 py-2 text-sm font-medium transition-colors',
              active ? 'text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {link.label}
            {active ? (
              <span className="absolute inset-x-2 -bottom-0.5 h-0.5 rounded-full bg-primary" />
            ) : null}
          </Link>
        )
      })}
    </nav>
  )
}
