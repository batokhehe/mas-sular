'use client'

import Link from 'next/link'
import { Minus, Plus, Trash2, ChevronRight } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { Empty } from '@/components/common/empty'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore, cartSubtotal } from '@/lib/stores/cart-store'

export default function CartPage() {
  const lines = useCartStore((s) => s.lines)
  const setQty = useCartStore((s) => s.setQty)
  const remove = useCartStore((s) => s.remove)
  const clear = useCartStore((s) => s.clear)
  const subtotal = cartSubtotal(lines)

  if (lines.length === 0) {
    return (
      <StorefrontShell>
        <section className="mx-auto max-w-3xl px-4 py-8">
          <h1 className="mb-6 text-2xl font-bold">Your Cart</h1>
          <Empty
            title="Your cart is empty"
            description="Add some bakso to get started."
            action={
              <Button asChild className="mt-2">
                <Link href="/catalog">Browse catalog</Link>
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
          <h1 className="text-2xl font-bold">Your Cart</h1>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => clear()}>
            Clear all
          </Button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          {/* Items */}
          <div className="space-y-3">
            {lines.map((line) => (
              <Card key={line.productId} className="flex gap-4 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={line.imageUrl} alt={line.name} className="size-20 shrink-0 rounded-xl object-cover" />
                <div className="flex flex-1 flex-col">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/catalog/${line.slug}`} className="line-clamp-1 font-semibold hover:underline">
                        {line.name}
                      </Link>
                      <p className="text-sm text-muted-foreground">{formatIDR(line.price)} each</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => remove(line.productId)}
                      aria-label="Remove item"
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
                        onClick={() => setQty(line.productId, line.qty - 1)}
                        aria-label="Decrease quantity"
                      >
                        <Minus className="size-3.5" />
                      </Button>
                      <span className="w-7 text-center text-sm font-medium">{line.qty}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full"
                        onClick={() => setQty(line.productId, line.qty + 1)}
                        aria-label="Increase quantity"
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    </div>
                    {/* Line total = real unit price × real quantity (the same per-line
                        summation the store's cartSubtotal already performs). */}
                    <p className="font-semibold text-primary">{formatIDR(line.price * line.qty)}</p>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Summary — subtotal only. Shipping/discounts/total are computed by the
              server at checkout (matching the checkout page), never fabricated here. */}
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Card className="space-y-4 p-5">
              <h2 className="font-semibold">Order summary</h2>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal ({lines.length} items)</span>
                <span className="font-medium">{formatIDR(subtotal)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Shipping and discounts are calculated by the server at checkout.
              </p>
              <Separator />
              <Button asChild size="lg" className="w-full rounded-full">
                <Link href="/checkout">
                  Proceed to checkout
                  <ChevronRight className="ml-1 size-4" />
                </Link>
              </Button>
            </Card>
          </div>
        </div>
      </section>
    </StorefrontShell>
  )
}
