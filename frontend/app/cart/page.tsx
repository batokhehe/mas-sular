'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft,
  Minus,
  Plus,
  Trash2,
  ShoppingBag,
  ChevronRight,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { useCartStore } from '@/lib/store'
import { formatPrice } from '@/lib/data'
import { cn } from '@/lib/utils'
import { getProductImageSrc } from '@/lib/product-images'

export default function CartPage() {
  const router = useRouter()
  const { items, updateQuantity, removeItem, clearCart, getTotalPrice } = useCartStore()
  const [promoCode, setPromoCode] = useState('')
  const [promoApplied, setPromoApplied] = useState(false)

  const subtotal = getTotalPrice()
  const deliveryFee = subtotal >= 100000 ? 0 : 10000
  const discount = promoApplied ? Math.round(subtotal * 0.1) : 0
  const total = subtotal + deliveryFee - discount

  const handleApplyPromo = () => {
    if (promoCode.toLowerCase() === 'newuser20' || promoCode.toLowerCase() === 'weekend15') {
      setPromoApplied(true)
    }
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen pb-20 md:pb-0">
        <div className="hidden md:block">
          <Navbar />
        </div>
        
        <header className="sticky top-0 z-50 md:hidden bg-background border-b">
          <div className="flex items-center h-14 px-4 gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="font-semibold">Keranjang</h1>
          </div>
        </header>

        <main className="container max-w-2xl py-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center py-12"
          >
            <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-secondary flex items-center justify-center">
              <ShoppingBag className="h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Keranjang Kosong</h2>
            <p className="text-muted-foreground mb-6">
              Belum ada item di keranjang. Yuk mulai belanja!
            </p>
            <Link href="/menu">
              <Button className="rounded-full">
                Lihat Menu
              </Button>
            </Link>
          </motion.div>
        </main>

        <BottomNav />
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-40 md:pb-0">
      <div className="hidden md:block">
        <Navbar />
      </div>

      {/* Mobile Header */}
      <header className="sticky top-0 z-50 md:hidden bg-background border-b">
        <div className="flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="font-semibold">Keranjang ({items.length})</h1>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={clearCart}
          >
            Hapus Semua
          </Button>
        </div>
      </header>

      <main className="container max-w-4xl py-4 md:py-8">
        <div className="hidden md:flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Keranjang Belanja</h1>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={clearCart}
          >
            Hapus Semua
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* Cart Items */}
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -100 }}
                  className="flex gap-4 p-4 bg-card border rounded-2xl"
                >
                  <div className="relative h-20 w-20 sm:h-24 sm:w-24 rounded-xl overflow-hidden bg-secondary shrink-0">
                    <Image
                      src={getProductImageSrc(item.product)}
                      alt={item.product.name}
                      fill
                      className="object-cover"
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="font-semibold text-sm sm:text-base line-clamp-1">
                          {item.product.name}
                        </h3>
                        {item.toppings.length > 0 && (
                          <p className="text-xs text-muted-foreground line-clamp-1">
                            + {item.toppings.map((t) => t.name).join(', ')}
                          </p>
                        )}
                        {item.notes && (
                          <p className="text-xs text-muted-foreground italic line-clamp-1">
                            &quot;{item.notes}&quot;
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                        onClick={() => removeItem(item.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="flex items-end justify-between mt-2">
                      <div className="flex items-center gap-2 bg-secondary rounded-full">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          onClick={() => updateQuantity(item.id, item.quantity - 1)}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-6 text-center text-sm font-medium">
                          {item.quantity}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          onClick={() => updateQuantity(item.id, item.quantity + 1)}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                      <p className="font-semibold text-primary">
                        {formatPrice(
                          (item.product.price +
                            item.toppings.reduce((sum, t) => sum + t.price, 0)) *
                            item.quantity
                        )}
                      </p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Order Summary */}
          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-4">
              {/* Promo Code */}
              <div className="p-4 bg-card border rounded-2xl">
                <h3 className="font-semibold mb-3">Kode Promo</h3>
                <div className="flex gap-2">
                  <Input
                    placeholder="Masukkan kode promo"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    disabled={promoApplied}
                  />
                  <Button
                    variant={promoApplied ? 'secondary' : 'default'}
                    onClick={handleApplyPromo}
                    disabled={promoApplied || !promoCode}
                  >
                    {promoApplied ? 'Diterapkan' : 'Terapkan'}
                  </Button>
                </div>
              </div>

              {/* Summary */}
              <div className="p-4 bg-card border rounded-2xl">
                <h3 className="font-semibold mb-4">Ringkasan Belanja</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Subtotal ({items.length} item)
                    </span>
                    <span>{formatPrice(subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ongkos Kirim</span>
                    <span className={cn(deliveryFee === 0 && 'text-green-600')}>
                      {deliveryFee === 0 ? 'GRATIS' : formatPrice(deliveryFee)}
                    </span>
                  </div>
                  {discount > 0 && (
                    <div className="flex justify-between text-green-600">
                      <span>Diskon Promo</span>
                      <span>-{formatPrice(discount)}</span>
                    </div>
                  )}
                  <div className="pt-3 border-t flex justify-between font-semibold text-base">
                    <span>Total</span>
                    <span className="text-primary">{formatPrice(total)}</span>
                  </div>
                </div>
                {subtotal < 100000 && (
                  <p className="text-xs text-muted-foreground mt-3">
                    Belanja {formatPrice(100000 - subtotal)} lagi untuk gratis ongkir!
                  </p>
                )}
              </div>

              <Link href="/checkout">
                <Button className="w-full rounded-full" size="lg">
                  Lanjut ke Pembayaran
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile Footer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t p-4 lg:hidden">
        {/* Promo Input - Mobile */}
        <div className="flex gap-2 mb-3">
          <Input
            placeholder="Kode promo"
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value)}
            disabled={promoApplied}
            className="text-sm"
          />
          <Button
            variant={promoApplied ? 'secondary' : 'outline'}
            size="sm"
            onClick={handleApplyPromo}
            disabled={promoApplied || !promoCode}
          >
            {promoApplied ? 'OK' : 'Pakai'}
          </Button>
        </div>

        {/* Summary & Checkout */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-lg font-bold text-primary">{formatPrice(total)}</p>
          </div>
          <Link href="/checkout" className="flex-1">
            <Button className="w-full rounded-full">
              Checkout ({items.length})
            </Button>
          </Link>
        </div>
      </div>

      <div className="hidden md:block">
        <BottomNav />
      </div>
    </div>
  )
}
