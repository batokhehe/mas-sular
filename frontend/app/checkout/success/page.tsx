'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { UploadReceipt } from '@/components/storefront/upload-receipt'
import { Empty } from '@/components/common/empty'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatIDR } from '@/lib/utils/format'
import { paymentBreakdownFromOrder } from '@/lib/checkout/summary'
import { PaymentBreakdown } from '@/components/storefront/payment-breakdown'
import { useLastOrderStore } from '@/lib/stores/last-order-store'
import { paymentMethodLabel } from '@/lib/invoice/labels'

const NEEDS_RECEIPT = new Set(['BANK_TRANSFER', 'QRIS'])

export default function CheckoutSuccessPage() {
  const order = useLastOrderStore((s) => s.order)
  const [showUpload, setShowUpload] = useState(false)

  if (!order) {
    return (
      <StorefrontShell>
        <Empty
          title="Tidak ada pesanan terbaru"
          description="Detail pesanan terakhir Anda sudah tidak tersedia di sini."
          action={
            <Button asChild className="mt-2">
              <Link href="/orders">Lihat riwayat pesanan</Link>
            </Button>
          }
        />
      </StorefrontShell>
    )
  }

  const needsReceipt = NEEDS_RECEIPT.has(order.paymentMethod) && order.payment?.id

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-xl px-4 py-8">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <CheckCircle2 className="size-12 text-green-600" />
          <h1 className="text-2xl font-bold">Pesanan berhasil dibuat!</h1>
          <p className="text-muted-foreground">Terima kasih atas pesanan Anda.</p>
        </div>

        <Card className="space-y-3 p-5">
          <Row label="Nomor pesanan" value={order.orderNumber} />
          <Row label="Metode pembayaran" value={paymentMethodLabel(order.paymentMethod)} />
          {order.paymentMethod === 'BANK_TRANSFER' ? (
            // Manual transfer: show the full breakdown (backend values only). The
            // unique-code row hides itself when the code is null (same value shown
            // for Business Total and Transfer Exactly).
            <PaymentBreakdown {...paymentBreakdownFromOrder(order)} />
          ) : (
            <Row label="Total" value={formatIDR(order.totalPrice)} />
          )}
          <Separator />
          {needsReceipt ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Selesaikan pembayaran, lalu unggah bukti pembayaran. Tautan unggah juga sudah kami kirim ke email Anda.
              </p>
              {showUpload ? (
                <UploadReceipt mode="auth" reference={order.payment!.id} />
              ) : (
                <Button className="w-full" onClick={() => setShowUpload(true)}>
                  Unggah bukti pembayaran
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Pesanan Anda sedang diproses.</p>
          )}
        </Card>

        <div className="mt-6 flex justify-center gap-3">
          <Button asChild variant="outline">
            <Link href="/orders">Riwayat pesanan</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/catalog">Lanjut belanja</Link>
          </Button>
        </div>
      </section>
    </StorefrontShell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )
}
