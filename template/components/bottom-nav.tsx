'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { motion } from 'framer-motion'
import { Home, UtensilsCrossed, ClipboardList, User, ShoppingCart } from 'lucide-react'
import { useCartStore, useAuthStore } from '@/lib/store'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/', icon: Home, label: 'Beranda' },
  { href: '/menu', icon: UtensilsCrossed, label: 'Menu' },
  { href: '/cart', icon: ShoppingCart, label: 'Keranjang' },
  { href: '/orders', icon: ClipboardList, label: 'Pesanan' },
  { href: '/profile', icon: User, label: 'Profil' },
]

export function BottomNav() {
  const pathname = usePathname()
  const cartItems = useCartStore((state) => state.getTotalItems())
  const { isAuthenticated } = useAuthStore()

  // Don't show bottom nav on auth pages
  if (pathname.startsWith('/login') || pathname.startsWith('/onboarding')) {
    return null
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden">
      <div className="bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t">
        <div className="flex items-center justify-around h-16 px-2">
          {navItems.map((item) => {
            const isActive = pathname === item.href
            const Icon = item.icon
            const showBadge = item.href === '/cart' && cartItems > 0
            const requiresAuth = item.href === '/profile' || item.href === '/orders'
            const linkHref = requiresAuth && !isAuthenticated ? '/login' : item.href

            return (
              <Link
                key={item.href}
                href={linkHref}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-1 w-16 h-full transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <div className="relative">
                  <Icon className="h-5 w-5" />
                  {showBadge && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="absolute -top-1 -right-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold"
                    >
                      {cartItems > 9 ? '9+' : cartItems}
                    </motion.span>
                  )}
                </div>
                <span className="text-[10px] font-medium">{item.label}</span>
                {isActive && (
                  <motion.div
                    layoutId="bottom-nav-indicator"
                    className="absolute top-0 left-3 right-3 h-0.5 bg-primary rounded-full"
                  />
                )}
              </Link>
            )
          })}
        </div>
      </div>
      {/* Safe area spacer for iOS */}
      <div className="h-[env(safe-area-inset-bottom)] bg-background" />
    </nav>
  )
}
