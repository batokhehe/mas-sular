'use client'

import { useEffect, useMemo, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  MapPin,
  ChevronRight,
  CheckCircle2,
  Loader2,
  TicketPercent,
  Truck,
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
import { getProductImageSrc } from '@/lib/product-images'
import { checkoutApi } from '@/lib/api'
import type { CheckoutCourier, CheckoutItemRequest, CheckoutSummaryResponse } from '@/lib/types'

const couriers: Array<{ id: CheckoutCourier; name: string; description: string }> = [
  { id: 'paxel', name: 'Paxel', description: 'Estimasi cepat untuk area terjangkau' },
  { id: 'jne', name: 'JNE', description: 'Layanan reguler antar kota' },
]

function getErrorMessage(error: unknown) {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { data?: { message?: string | string[] } } }).response
    const message = response?.data?.message
    return Array.isArray(message) ? message.join(', ') : message
  }

  return undefined
}

export default function CheckoutPage() {
  const router = useRouter()
  const { items, clearCart } = useCartStore()
  const selectedAddress = useAddressStore((state) => state.getSelectedAddress())
  const { isAuthenticated } = useAuthStore()

  const [courier, setCourier] = useState<CheckoutCourier>('paxel')
  const [voucherCode, setVoucherCode] = useState('')
  const [summary, setSummary] = useState<CheckoutSummaryResponse | null>(null)
  const [summaryError, setSummaryError] = useState('')
  const [isSummaryLoading, setIsSummaryLoading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [orderSuccess, setOrderSuccess] = useState(false)

  const checkoutItems = useMemo<CheckoutItemRequest[]>(
    () =>
      items.map((item) => ({
        product_id: item.product.id,
        qty: item.quantity,
        topping_ids: item.toppings.map((topping) => topping.id),
        spicyLevel: item.spicyLevel,
        notes: item.notes,
      })),
    [items]
  )

  useEffect(() => {
    let isActive = true
    const trimmedVoucher = voucherCode.trim().toUpperCase()

    async function refreshSummary() {
      if (!selectedAddress || checkoutItems.length === 0) {
        setSummary(null)
        setSummaryError('')
        return
      }

      setIsSummaryLoading(true)
      setSummaryError('')

      try {
        const nextSummary = await checkoutApi.getSummary({
          address_id: selectedAddress.id,
          courier,
          voucher_code: trimmedVoucher || undefined,
          items: checkoutItems,
        })

        if (isActive) {
          setSummary(nextSummary)
        }
      } catch (error) {
        if (isActive) {
          setSummary(null)
          setSummaryError(getErrorMessage(error) || 'Gagal menghitung checkout')
        }
      } finally {
        if (isActive) {
          setIsSummaryLoading(false)
        }
      }
    }

    refreshSummary()

    return () => {
      isActive = false
    }
  }, [checkoutItems, courier, selectedAddress, voucherCode])

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

  const handleApplyVoucher = async () => {
    if (!summary || !voucherCode.trim()) return

    const result = await checkoutApi.validateVoucher({
      voucher_code: voucherCode.trim().toUpperCase(),
      subtotal: summary.subtotal,
    })

    if (result.valid) {
      toast.success('Voucher berhasil diterapkan')
      return
    }

    toast.error(result.message || 'Voucher tidak valid')
  }

  const handlePlaceOrder = async () => {
    if (!isAuthenticated) {
      router.push('/login')
      return
    }

    if (!selectedAddress) {
      toast.error('Pilih alamat pengiriman terlebih dahulu')
      return
    }

    if (!summary) {
      toast.error(summaryError || 'Ringkasan checkout belum siap')
      return
    }

    setIsProcessing(true)

    try {
      await checkoutApi.createOrder({
        address_id: selectedAddress.id,
        courier,
        voucher_code: voucherCode.trim().toUpperCase() || undefined,
        items: checkoutItems,
      })

      setOrderSuccess(true)
      clearCart()
      toast.success('Pesanan berhasil dibuat!')
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Gagal membuat pesanan')
    } finally {
      setIsProcessing(false)
    }
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

  const totalLabel = summary ? formatPrice(summary.grand_total) : isSummaryLoading ? 'Menghitung...' : '-'

  return (
    <div className="min-h-screen pb-32 md:pb-0">
      <div className="hidden md:block">
        <Navbar />
      </div>

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

            <div className="p-4 bg-card border rounded-2xl">
              <h3 className="font-semibold mb-3">Kurir Pengiriman</h3>
              <RadioGroup value={courier} onValueChange={(value) => setCourier(value as CheckoutCourier)}>
                <div className="space-y-2">
                  {couriers.map((option) => (
                    <Label
                      key={option.id}
                      htmlFor={option.id}
                      className={cn(
                        'flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors',
                        courier === option.id ? 'border-primary bg-primary/5' : 'hover:border-primary/50'
                      )}
                    >
                      <RadioGroupItem value={option.id} id={option.id} />
                      <Truck className="h-5 w-5 text-muted-foreground" />
                      <div className="flex-1">
                        <p className="font-medium text-sm">{option.name}</p>
                        <p className="text-xs text-muted-foreground">{option.description}</p>
                      </div>
                    </Label>
                  ))}
                </div>
              </RadioGroup>
            </div>

            <div className="p-4 bg-card border rounded-2xl lg:hidden">
              <h3 className="font-semibold mb-3">Voucher</h3>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <TicketPercent className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9 uppercase"
                    placeholder="WELCOME10"
                    value={voucherCode}
                    onChange={(e) => setVoucherCode(e.target.value)}
                  />
                </div>
                <Button variant="outline" onClick={handleApplyVoucher} disabled={!voucherCode.trim() || !summary}>
                  Terapkan
                </Button>
              </div>
            </div>

            <div className="p-4 bg-card border rounded-2xl">
              <h3 className="font-semibold mb-3">Pesanan ({items.length} item)</h3>
              <div className="space-y-3">
                {items.map((item) => (
                  <div key={item.id} className="flex gap-3">
                    <div className="relative h-16 w-16 rounded-lg overflow-hidden bg-secondary shrink-0">
                      <Image src={getProductImageSrc(item.product)} alt={item.product.name} fill className="object-cover" />
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
                      <p className="text-sm text-muted-foreground mt-1">Harga dihitung ulang oleh sistem saat checkout</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 bg-card border rounded-2xl lg:hidden">
              <h3 className="font-semibold mb-4">Ringkasan Pesanan</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{summary ? formatPrice(summary.subtotal) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ongkos Kirim</span>
                  <span>{summary ? formatPrice(summary.shipping_cost) : '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Diskon</span>
                  <span>{summary ? `-${formatPrice(summary.discount)}` : '-'}</span>
                </div>
                {summary?.estimated_days && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Estimasi</span>
                    <span>{summary.estimated_days} hari</span>
                  </div>
                )}
                <div className="pt-3 border-t flex justify-between font-semibold text-base">
                  <span>Total Pembayaran</span>
                  <span className="text-primary">{totalLabel}</span>
                </div>
              </div>
              {summaryError && <p className="mt-3 text-sm text-destructive">{summaryError}</p>}
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="sticky top-24 space-y-4">
              <div className="p-4 bg-card border rounded-2xl">
                <h3 className="font-semibold mb-3">Voucher</h3>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <TicketPercent className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="pl-9 uppercase"
                      placeholder="WELCOME10"
                      value={voucherCode}
                      onChange={(e) => setVoucherCode(e.target.value)}
                    />
                  </div>
                  <Button variant="outline" onClick={handleApplyVoucher} disabled={!voucherCode.trim() || !summary}>
                    Terapkan
                  </Button>
                </div>
              </div>

              <div className="p-4 bg-card border rounded-2xl">
                <h3 className="font-semibold mb-4">Ringkasan Pesanan</h3>
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{summary ? formatPrice(summary.subtotal) : '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Ongkos Kirim</span>
                    <span>{summary ? formatPrice(summary.shipping_cost) : '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Diskon</span>
                    <span>{summary ? `-${formatPrice(summary.discount)}` : '-'}</span>
                  </div>
                  {summary?.estimated_days && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Estimasi</span>
                      <span>{summary.estimated_days} hari</span>
                    </div>
                  )}
                  <div className="pt-3 border-t flex justify-between font-semibold text-base">
                    <span>Total Pembayaran</span>
                    <span className="text-primary">{totalLabel}</span>
                  </div>
                </div>
                {summaryError && <p className="mt-3 text-sm text-destructive">{summaryError}</p>}
              </div>

              <Button
                className="w-full rounded-full"
                size="lg"
                onClick={handlePlaceOrder}
                disabled={isProcessing || isSummaryLoading || !selectedAddress || !summary}
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Memproses...
                  </>
                ) : (
                  `Checkout ${totalLabel}`
                )}
              </Button>
            </div>
          </div>
        </div>
      </main>

      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t p-4 lg:hidden">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div>
            <p className="text-xs text-muted-foreground">Total Pembayaran</p>
            <p className="text-lg font-bold text-primary">{totalLabel}</p>
            {summaryError && <p className="text-xs text-destructive">{summaryError}</p>}
          </div>
          <Button
            className="flex-1 rounded-full"
            onClick={handlePlaceOrder}
            disabled={isProcessing || isSummaryLoading || !selectedAddress || !summary}
          >
            {isProcessing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Memproses...
              </>
            ) : (
              'Buat Pesanan'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
