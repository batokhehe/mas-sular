'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  MapPin,
  ChevronRight,
  CreditCard,
  Wallet,
  Banknote,
  CheckCircle2,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Navbar } from '@/components/navbar'
import { useCartStore, useAddressStore, useAuthStore } from '@/lib/store'
import { formatPrice } from '@/lib/data'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const paymentMethods = [
  { id: 'qris', name: 'QRIS', icon: CreditCard, description: 'Scan QR untuk bayar' },
  { id: 'transfer', name: 'Bank Transfer', icon: Banknote, description: 'Transfer manual' },
  { id: 'cod', name: 'Bayar di Tempat (COD)', icon: Wallet, description: 'Bayar saat pesanan tiba' },
]

export default function CheckoutPage() {
  const router = useRouter()
  const { items, getTotalPrice, clearCart } = useCartStore()
  const selectedAddress = useAddressStore((state) => state.getSelectedAddress())
  const { isAuthenticated } = useAuthStore()
  
  const [paymentMethod, setPaymentMethod] = useState('qris')
  const [promoCode, setPromoCode] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [orderSuccess, setOrderSuccess] = useState(false)

  const subtotal = getTotalPrice()
  const deliveryFee = subtotal >= 100000 ? 0 : 10000
  const total = subtotal + deliveryFee

  // Redirect if cart is empty
  if (items.length === 0 && !orderSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-semibold mb-2">Keranjang kosong</h1>
          <Link href="/menu">
            <Button>Lihat Menu</Button>
          </Link>
        </div>
      </div>
    )
  }

  const handlePlaceOrder = async () => {
    if (!selectedAddress) {
      toast.error('Pilih alamat pengiriman terlebih dahulu')
      return
    }

    setIsProcessing(true)
    
    // Simulate order processing
    await new Promise((resolve) => setTimeout(resolve, 2000))
    
    setIsProcessing(false)
    setOrderSuccess(true)
    clearCart()
    toast.success('Pesanan berhasil dibuat!')
  }

  if (orderSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center max-w-sm"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: 'spring' }}
            className="w-20 h-20 mx-auto mb-6 rounded-full bg-green-100 flex items-center justify-center"
          >
            <CheckCircle2 className="h-10 w-10 text-green-600" />
          </motion.div>
          <h1 className="text-2xl font-bold mb-2">Pesanan Berhasil!</h1>
          <p className="text-muted-foreground mb-6">
            Terima kasih atas pesanan Anda. Pesanan sedang diproses dan akan segera dikirim.
          </p>
          <div className="space-y-3">
            <Link href="/orders">
              <Button className="w-full rounded-full">Lihat Pesanan</Button>
            </Link>
            <Link href="/">
              <Button variant="outline" className="w-full rounded-full">
                Kembali ke Beranda
              </Button>
            </Link>
          </div>
        </motion.div>
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-32 md:pb-0">
      <div className="hidden md:block">
        <Navbar />
      </div>

      {/* Mobile Header */}
      <header className="sticky top-0 z-50 md:hidden bg-background border-b">
        <div className="flex items-center h-14 px-4 gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Checkout</h1>
        </div>
      </header>

      <main className="container max-w-4xl py-4 md:py-8">
        <h1 className="hidden md:block text-2xl font-bold mb-6">Checkout</h1>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            {/* Delivery Address */}
            <div className="p-4 bg-card border rounded-2xl">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold">Alamat Pengiriman</h3>
                <Link href={isAuthenticated ? '/profile' : '/onboarding'}>
                  <Button variant="ghost" size="sm" className="text-primary">
                    {selectedAddress ? 'Ubah' : 'Tambah'}
                  </Button>
                </Link>
              </div>
              
              {selectedAddress ? (
                <div className="flex gap-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <MapPin className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">{selectedAddress.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {selectedAddress.recipientName} - {selectedAddress.phone}
                    </p>
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {selectedAddress.fullAddress}
                    </p>
                  </div>
                </div>
              ) : (
                <Link href={isAuthenticated ? '/profile' : '/login'}>
                  <div className="flex items-center gap-3 p-3 border border-dashed rounded-xl text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                    <MapPin className="h-5 w-5" />
                    <span className="text-sm">Tambah alamat pengiriman</span>
                    <ChevronRight className="h-4 w-4 ml-auto" />
                  </div>
                </Link>
              )}
            </div>

            {/* Order Items */}
            <div className="p-4 bg-card border rounded-2xl">
              <h3 className="font-semibold mb-3">Pesanan ({items.length} item)</h3>
              <div className="space-y-3">
                {items.map((item) => (
                  <div key={item.id} className="flex gap-3">
                    <div className="relative h-16 w-16 rounded-lg overflow-hidden bg-secondary shrink-0">
                      <Image
                        src={item.product.image}
                        alt={item.product.name}
                        fill
                        className="object-cover"
                      />
                      <div className="absolute bottom-0 right-0 bg-primary text-primary-foreground text-xs font-bold px-1.5 py-0.5 rounded-tl">
                        x{item.quantity}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm line-clamp-1">{item.product.name}</p>
                      {item.toppings.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          + {item.toppings.map((t) => t.name).join(', ')}
                        </p>
                      )}
                      <p className="text-sm font-semibold text-primary mt-1">
                        {formatPrice(
                          (item.product.price +
                            item.toppings.reduce((sum, t) => sum + t.price, 0)) *
                            item.quantity
                        )}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Payment Method */}
            <div className="p-4 bg-card border rounded-2xl">
              <h3 className="font-semibold mb-3">Metode Pembayaran</h3>
              <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod}>
                <div className="space-y-2">
                  {paymentMethods.map((method) => {
                    const Icon = method.icon
                    return (
                      <Label
                        key={method.id}
                        htmlFor={method.id}
                        className={cn(
                          'flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors',
                          paymentMethod === method.id
                            ? 'border-primary bg-primary/5'
                            : 'hover:border-primary/50'
                        )}
                      >
                        <RadioGroupItem value={method.id} id={method.id} />
                        <Icon className="h-5 w-5 text-muted-foreground" />
                        <div className="flex-1">
                          <p className="font-medium text-sm">{method.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {method.description}
                          </p>
                        </div>
                      </Label>
                    )
                  })}
                </div>
              </RadioGroup>
            </div>
          </div>

          {/* Order Summary - Desktop */}
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
                  />
                  <Button variant="outline">Terapkan</Button>
                </div>
              </div>

              {/* Summary */}
              <div className="p-4 bg-card border rounded-2xl">
                <h3 className="font-semibold mb-4">Ringkasan Pembayaran</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{formatPrice(subtotal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ongkos Kirim</span>
                    <span className={cn(deliveryFee === 0 && 'text-green-600')}>
                      {deliveryFee === 0 ? 'GRATIS' : formatPrice(deliveryFee)}
                    </span>
                  </div>
                  <div className="pt-3 border-t flex justify-between font-semibold text-base">
                    <span>Total Pembayaran</span>
                    <span className="text-primary">{formatPrice(total)}</span>
                  </div>
                </div>
              </div>

              <Button
                className="w-full rounded-full"
                size="lg"
                onClick={handlePlaceOrder}
                disabled={isProcessing || !selectedAddress}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Memproses...
                  </>
                ) : (
                  `Bayar ${formatPrice(total)}`
                )}
              </Button>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile Footer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t p-4 lg:hidden">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">Total Pembayaran</p>
            <p className="text-lg font-bold text-primary">{formatPrice(total)}</p>
          </div>
          <Button
            className="flex-1 rounded-full"
            onClick={handlePlaceOrder}
            disabled={isProcessing || !selectedAddress}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Memproses...
              </>
            ) : (
              'Bayar Sekarang'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
