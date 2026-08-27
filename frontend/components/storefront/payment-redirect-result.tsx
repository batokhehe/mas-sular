'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CheckCircle2, Clock, Home, Package, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatIDR } from '@/lib/utils/format'
import { hasCustomerSession } from '@/lib/auth/tokens'
import { channelLabel, parseMidtransRedirect, type MidtransRedirect } from '@/lib/payments/redirect-params'

type Variant = 'success' | 'pending' | 'failed'

const COPY: Record<Variant, { title: string; body: string; note?: string }> = {
  success: {
    title: 'Pembayaran Berhasil',
    // Deliberately NOT "pesanan sudah diproses": the redirect can arrive before the
    // webhook has been processed, and the backend is the only source of truth.
    body: 'Pembayaran Anda telah diterima oleh sistem pembayaran. Detail pesanan akan diperbarui secara otomatis.',
    note: 'Anda akan menerima notifikasi WhatsApp setelah pesanan diperbarui.',
  },
  pending: {
    title: 'Menunggu Pembayaran',
    body: 'Pembayaran Anda belum selesai. Jika Anda sudah melakukan pembayaran, status pesanan akan diperbarui otomatis.',
    note: 'Halaman ini tidak perlu dimuat ulang — pembaruan status berjalan di latar belakang.',
  },
  failed: {
    title: 'Pembayaran Tidak Berhasil',
    // No raw provider error is ever surfaced to the customer.
    body: 'Pembayaran Anda tidak dapat diselesaikan. Tidak ada dana yang terpotong. Anda dapat mencoba kembali dari halaman pesanan.',
  },
}

const ICON: Record<Variant, { Icon: typeof CheckCircle2; wrap: string; tint: string }> = {
  success: { Icon: CheckCircle2, wrap: 'bg-green-100', tint: 'text-green-600' },
  pending: { Icon: Clock, wrap: 'bg-amber-100', tint: 'text-amber-600' },
  failed: { Icon: XCircle, wrap: 'bg-destructive/10', tint: 'text-destructive' },
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}

/**
 * Shared UX for the three Midtrans redirect landings.
 *
 * DISPLAY ONLY. The query parameters Midtrans appends are shown for the customer's
 * reassurance and nothing else: this component performs no mutation, calls no
 * "mark paid" endpoint, starts no payment, and polls neither Midtrans nor our API.
 * The webhook (`POST /api/v1/payments/webhook/midtrans`) remains the sole authority
 * on payment state, exactly as Phase 5B–5E established.
 */
export function PaymentRedirectResult({ variant }: { variant: Variant }) {
  const [redirect, setRedirect] = useState<MidtransRedirect | null>(null)
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    setRedirect(parseMidtransRedirect(new URLSearchParams(window.location.search)))
    setSignedIn(hasCustomerSession())
  }, [])

  const { title, body, note } = COPY[variant]
  const { Icon, wrap, tint } = ICON[variant]
  const hasDetails = Boolean(redirect?.orderNumber || redirect?.channel || redirect?.amount)

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <Card className="flex flex-col items-center gap-4 p-8 text-center">
        <div className={`flex size-16 items-center justify-center rounded-full ${wrap}`}>
          <Icon className={`size-10 ${tint}`} />
        </div>

        <h1 className="text-xl font-bold">{title}</h1>

        {redirect?.orderNumber ? (
          <div className="rounded-full bg-muted px-3 py-1 text-sm">
            <span className="text-muted-foreground">Pesanan</span>{' '}
            <span className="font-semibold">{redirect.orderNumber}</span>
          </div>
        ) : null}

        <p className="text-sm text-muted-foreground">{body}</p>

        {hasDetails ? (
          <>
            <Separator />
            <div className="flex w-full flex-col gap-2">
              {redirect?.channel ? <Row label="Metode pembayaran" value={channelLabel(redirect.channel)} /> : null}
              {redirect?.amount != null ? <Row label="Total" value={formatIDR(redirect.amount)} /> : null}
            </div>
          </>
        ) : null}

        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}

        <div className="mt-2 flex w-full flex-col gap-2">
          {/* "Lihat Pesanan" is the primary action everywhere: the backend is where
              the real status lives. No retry CTA — no retry endpoint exists. */}
          {signedIn ? (
            <Button asChild className="w-full">
              <Link href="/orders">
                <Package className="mr-2 size-4" /> Lihat Pesanan
              </Link>
            </Button>
          ) : null}
          <Button asChild variant={signedIn ? 'outline' : 'default'} className="w-full">
            <Link href="/">
              <Home className="mr-2 size-4" /> Kembali ke Beranda
            </Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
