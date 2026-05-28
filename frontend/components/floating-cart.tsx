'use client'

import Link from 'next/link'
import { motion } from 'framer-motion'
import { ShoppingCart } from 'lucide-react'
import { useCartStore } from '@/lib/store'
import { formatPrice } from '@/lib/data'
import { usePathname } from 'next/navigation'

export function FloatingCart() {
  const pathname = usePathname()
  const items = useCartStore((state) => state.items)
  const totalItems = useCartStore((state) => state.getTotalItems())
  const totalPrice = useCartStore((state) => state.getTotalPrice())

  // Don't show on cart page or if cart is empty
  if (pathname === '/cart' || pathname === '/checkout' || items.length === 0) {
    return null
  }

  // Hide on auth pages
  if (pathname.startsWith('/login') || pathname.startsWith('/onboarding')) {
    return null
  }

  return (
    <motion.div
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      className="fixed bottom-20 left-4 right-4 z-40 md:bottom-6 md:left-auto md:right-6 md:w-auto"
    >
      <Link href="/cart">
        <motion.div
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex items-center justify-between gap-4 rounded-2xl bg-primary px-5 py-4 text-primary-foreground shadow-lg shadow-primary/25"
        >
          <div className="flex items-center gap-3">
            <div className="relative">
              <ShoppingCart className="h-6 w-6" />
              <span className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-background text-foreground text-xs font-bold">
                {totalItems}
              </span>
            </div>
            <div className="hidden md:block">
              <p className="text-sm font-medium">Keranjang</p>
              <p className="text-xs opacity-90">{totalItems} item</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-bold text-lg">{formatPrice(totalPrice)}</span>
            <span className="hidden md:inline-block rounded-full bg-primary-foreground/20 px-3 py-1 text-sm font-medium">
              Lihat
            </span>
          </div>
        </motion.div>
      </Link>
    </motion.div>
  )
}
