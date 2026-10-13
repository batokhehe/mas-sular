'use client'

import Link from 'next/link'
import { Minus, Plus, Trash2, ChevronRight } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { Empty } from '@/components/common/empty'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore, selectedLines, selectedSubtotal, lineUnitPrice, lineTotal } from '@/lib/stores/cart-store'

export default function CartPage() {
  const lines = useCartStore((s) => s.lines)
  const setQty = useCartStore((s) => s.setQty)
  const remove = useCartStore((s) => s.remove)
  const clear = useCartStore((s) => s.clear)
  const setSelected = useCartStore((s) => s.setSelected)
  const setAllSelected = useCartStore((s) => s.setAllSelected)
  // P2 #6: only ticked lines go to checkout, and only they count in the subtotal.
  const selectedCount = selectedLines(lines).length
  const allSelected = lines.length > 0 && selectedCount === lines.length
  const subtotal = selectedSubtotal(lines)

  if (lines.length === 0) {
    return (
      <StorefrontShell>
        <section className="mx-auto max-w-3xl px-4 py-8">
          <h1 className="mb-6 text-2xl font-bold">Keranjang Saya</h1>
          <Empty
            title="Keranjang Anda kosong"
            description="Yuk, tambahkan bakso favorit Anda."
            action={
              <Button asChild className="mt-2">
                <Link href="/catalog">Lihat Katalog</Link>
              </Button>
            }
          />
        </section>
      </StorefrontShell>
    )
  }

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Keranjang Saya</h1>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => clear()}>
            Hapus semua
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* Items */}
          <div className="space-y-3">
            <div className="flex items-center gap-3 px-1">
              <Checkbox
                id="cart-select-all"
                checked={allSelected}
                onCheckedChange={(checked) => setAllSelected(checked === true)}
              />
              <label htmlFor="cart-select-all" className="cursor-pointer text-sm font-medium">
                Pilih semua
              </label>
              <span className="text-sm text-muted-foreground">
                ({selectedCount} of {lines.length} selected)
              </span>
            </div>
            {lines.map((line) => (
              <Card key={line.lineId} className="flex gap-4 p-4">
                <div className="flex items-center gap-3">
                  <Checkbox
                    className="size-5"
                    checked={line.selected}
                    onCheckedChange={(checked) => setSelected(line.lineId, checked === true)}
                    aria-label={`Pilih ${line.name}`}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={line.imageUrl} alt={line.name} className="size-20 shrink-0 rounded-xl object-cover" />
                </div>
                <div className="flex flex-1 flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/catalog/${line.slug}`} className="line-clamp-1 font-semibold hover:underline">
                        {line.name}
                      </Link>
                      {line.toppings.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          + {line.toppings.map((t) => `${t.name} (${formatIDR(t.price)})`).join(', ')}
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground">{formatIDR(lineUnitPrice(line))} / item</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => remove(line.lineId)}
                      aria-label="Hapus item"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <div className="mt-auto flex items-end justify-between pt-3">
                    <div className="flex items-center gap-1 rounded-full bg-secondary p-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full"
                        onClick={() => setQty(line.lineId, line.qty - 1)}
                        aria-label="Kurangi jumlah"
                      >
                        <Minus className="size-3.5" />
                      </Button>
                      <span className="w-7 text-center text-sm font-medium">{line.qty}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full"
                        onClick={() => setQty(line.lineId, line.qty + 1)}
                        aria-label="Tambah jumlah"
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                    {/* Line total = unit price (product + toppings) × quantity (the same
                        per-line summation the store's cartSubtotal already performs). */}
                    <p className="font-semibold text-primary">{formatIDR(lineTotal(line))}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Summary — subtotal only. Shipping/discounts/total are computed by the
              server at checkout (matching the checkout page), never fabricated here. */}
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Card className="space-y-4 p-5">
              <h2 className="font-semibold">Ringkasan pesanan</h2>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  Subtotal ({selectedCount} dari {lines.length} item)
                </span>
                <span className="font-medium">{formatIDR(subtotal)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Ongkos kirim dan diskon dihitung saat checkout.
              </p>
              <Separator />
              {selectedCount > 0 ? (
                <Button asChild size="lg" className="w-full rounded-full">
                  <Link href="/checkout">
                    Lanjut ke Checkout
                    <ChevronRight className="ml-1 size-4" />
                  </Link>
                </Button>
              ) : (
                <>
                  <Button size="lg" className="w-full rounded-full" disabled>
                    Lanjut ke Checkout
                    <ChevronRight className="ml-1 size-4" />
                  </Button>
                  <p role="status" className="text-center text-sm text-muted-foreground">
                    Pilih minimal satu item untuk checkout.
                  </p>
                </>
              )}
            </Card>
          </div>
        </div>
      </section>
    </StorefrontShell>
  )
}
