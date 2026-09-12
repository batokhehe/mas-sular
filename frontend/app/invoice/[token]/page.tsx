'use client'

import { Suspense, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { FileX2, Loader2, Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { invoicesApi, type CustomerInvoice } from '@/lib/api/invoices.api'
import { formatIDR } from '@/lib/utils/format'
import { orderStatusLabel, paymentMethodLabel, paymentStatusLabel, shipmentStatusLabel } from '@/lib/invoice/labels'

/**
 * P2 #14: public customer invoice, opened from the link an admin sends over
 * WhatsApp. No login and no storefront chrome; the token from the URL is only
 * passed to the API and never shown. `?print=1` (Admin "Print invoice") opens the
 * browser print dialog once the invoice has loaded.
 */
export default function InvoicePage() {
  return (
    <Suspense fallback={<InvoiceLoading />}>
      <InvoiceView />
    </Suspense>
  )
}

function InvoiceView() {
  const params = useParams<{ token: string }>()
  const token = params?.token ?? ''
  const printRequested = useSearchParams().get('print') === '1'

  const { data, isLoading, isError } = useQuery({
    queryKey: ['invoice', token],
    queryFn: () => invoicesApi.get(token),
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
  })

  const printed = useRef(false)
  useEffect(() => {
    if (data && printRequested && !printed.current) {
      printed.current = true
      const t = setTimeout(() => window.print(), 300)
      return () => clearTimeout(t)
    }
  }, [data, printRequested])

  if (isLoading) return <InvoiceLoading />
  if (isError || !data) return <InvoiceUnavailable />
  return <InvoiceDocument invoice={data} />
}

function InvoiceLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Memuat invoice...
    </main>
  )
}

function InvoiceUnavailable() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <FileX2 className="size-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Link invoice tidak tersedia</h1>
      <p className="text-sm text-muted-foreground">
        Link ini tidak valid atau sudah kedaluwarsa. Silakan hubungi Bakso Mas Sular untuk mendapatkan link invoice yang baru.
      </p>
    </main>
  )
}

const dateId = (iso: string) =>
  new Intl.DateTimeFormat('id-ID', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }).format(new Date(iso))

function InvoiceDocument({ invoice }: { invoice: CustomerInvoice }) {
  const { payment, shipping, delivery } = invoice
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10 print:max-w-none print:p-0">
      <div className="mb-4 flex justify-end print:hidden">
        <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="mr-1.5 size-4" /> Cetak / Simpan PDF
        </Button>
      </div>

      <article className="rounded-2xl border bg-card p-5 shadow-sm sm:p-8 print:rounded-none print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5">
          <div>
            <p className="text-xl font-bold text-primary">{invoice.store.name}</p>
            <p className="text-sm text-muted-foreground">Invoice pesanan</p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-lg font-semibold [overflow-wrap:anywhere]">{invoice.orderNumber}</p>
            <p className="text-sm text-muted-foreground">{dateId(invoice.orderDate)}</p>
            <p className="mt-1 text-sm">
              Status: <span className="font-medium">{orderStatusLabel(invoice.orderStatus)}</span>
            </p>
          </div>
        </header>

        <section className="grid gap-5 border-b py-5 sm:grid-cols-2">
          <div className="min-w-0 space-y-1 text-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dikirim ke</h2>
            <p className="font-medium">{delivery.recipientName}</p>
            {delivery.phone ? <p className="text-muted-foreground">{delivery.phone}</p> : null}
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{delivery.address}</p>
          </div>
          <div className="min-w-0 space-y-1 text-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pengiriman</h2>
            <p className="font-medium">{[shipping.courier, shipping.service].filter(Boolean).join(' - ') || '-'}</p>
            {shipping.status ? <p className="text-muted-foreground">{shipmentStatusLabel(shipping.status)}</p> : null}
            {shipping.trackingNumber ? (
              <p className="text-muted-foreground [overflow-wrap:anywhere]">
                No. resi: <span className="font-medium text-foreground">{shipping.trackingNumber}</span>
              </p>
            ) : null}
          </div>
        </section>

        <section className="border-b py-5">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pesanan</h2>
          <ul className="divide-y">
            {invoice.items.map((item, i) => (
              <li key={`${item.name}-${i}`} className="flex items-start justify-between gap-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium [overflow-wrap:anywhere]">{item.name}</p>
                  <p className="text-muted-foreground">
                    {item.quantity} x {formatIDR(item.unitPrice)}
                  </p>
                  {item.toppings.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Topping: {item.toppings.map((t) => `${t.name} (+${formatIDR(t.price)})`).join(', ')}
                    </p>
                  ) : null}
                  {item.spicyLevel ? <p className="text-xs text-muted-foreground">Level pedas: {item.spicyLevel}</p> : null}
                  {item.notes ? <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">Catatan: {item.notes}</p> : null}
                </div>
                <p className="shrink-0 font-semibold">{formatIDR(item.lineTotal)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-2 border-b py-5 text-sm">
          <Row label="Subtotal" value={formatIDR(invoice.subtotal)} />
          {invoice.discount > 0 ? (
            <Row label={invoice.voucherCode ? `Diskon (${invoice.voucherCode})` : 'Diskon'} value={`- ${formatIDR(invoice.discount)}`} />
          ) : null}
          <Row label="Ongkos kirim" value={formatIDR(invoice.shippingCost)} />
          {/* Gateway orders always list the fee - Rp0 when the merchant absorbs it. */}
          {(invoice.paymentServiceFeeApplies ?? invoice.paymentServiceFee > 0) ? (
            <Row label="Biaya Layanan" value={formatIDR(invoice.paymentServiceFee)} />
          ) : null}
          <Row label="Total" value={formatIDR(invoice.total)} strong />
        </section>

        <section className="space-y-2 pt-5 text-sm">
          <Row label="Metode pembayaran" value={paymentMethodLabel(payment.method)} />
          <Row label="Status pembayaran" value={paymentStatusLabel(payment.status)} />
          {payment.uniqueCode != null ? (
            <>
              <Row label="Kode unik transfer" value={String(payment.uniqueCode)} />
              <Row label="Jumlah yang ditransfer" value={formatIDR(payment.amountDue)} strong />
            </>
          ) : null}
        </section>

        <footer className="mt-6 text-center text-xs text-muted-foreground">
          Terima kasih telah berbelanja di {invoice.store.name}.
        </footer>
      </article>
    </main>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${strong ? 'text-base font-semibold' : ''}`}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}
