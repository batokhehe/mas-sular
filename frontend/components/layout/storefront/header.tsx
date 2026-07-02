'use client'

import Link from 'next/link'
import { useState } from 'react'
import { usePathname } from 'next/navigation'
import { Menu, ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { AuthMenu } from '@/components/auth/auth-menu'
import { StorefrontNavigation, STOREFRONT_LINKS, isActivePath } from './navigation'
import { useCartStore, cartCount } from '@/lib/stores/cart-store'
import { cn } from '@/lib/utils'

export function StorefrontHeader() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const count = useCartStore((s) => cartCount(s.lines))

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
        {/* Brand */}
        <Link href="/" className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            BMS
          </span>
          <span className="hidden text-lg font-bold tracking-tight sm:inline-block">Bakso Mas Sular</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:block">
          <StorefrontNavigation />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon" className="relative" aria-label="Cart">
            <Link href="/cart">
              <ShoppingCart className="size-5" />
              {count > 0 ? (
                <Badge
                  variant="destructive"
                  className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full p-0 text-[10px]"
                >
                  {count > 9 ? '9+' : count}
                </Badge>
              ) : null}
            </Link>
          </Button>

          <AuthMenu />

          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <nav className="mt-8 flex flex-col gap-2">
                {STOREFRONT_LINKS.map((link) => {
                  const active = isActivePath(pathname, link.href)
                  const Icon = link.icon
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 rounded-xl px-4 py-3 text-base font-medium transition-colors',
                        active ? 'bg-primary text-primary-foreground' : 'hover:bg-accent',
                      )}
                    >
                      <Icon className="size-5" />
                      {link.label}
                    </Link>
                  )
                })}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
