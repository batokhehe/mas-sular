import Link from 'next/link'
import { ShoppingCart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AuthMenu } from '@/components/auth/auth-menu'
import { StorefrontNavigation } from './navigation'

export function StorefrontHeader() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Baso Nusantara
        </Link>
        <div className="hidden md:block">
          <StorefrontNavigation />
        </div>
        <div className="flex items-center gap-1">
          <Button asChild variant="ghost" size="icon" aria-label="Cart">
            <Link href="/cart">
              <ShoppingCart className="size-5" />
            </Link>
          </Button>
          <AuthMenu />
        </div>
      </div>
    </header>
  )
}
