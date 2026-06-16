'use client'

import Link from 'next/link'
import { Minus, Plus, Trash2 } from 'lucide-react'
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
  const subtotal = cartSubtotal(lines)

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Your Cart</h1>

        {lines.length === 0 ? (
          <Empty
            title="Your cart is empty"
            description="Add some bakso to get started."
            action={
              <Button asChild className="mt-2">
                <Link href="/catalog">Browse catalog</Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            {lines.map((line) => (
              <Card key={line.productId} className="flex items-center gap-4 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={line.imageUrl} alt={line.name} className="size-16 rounded-md object-cover" />
                <div className="flex-1">
                  <p className="font-semibold">{line.name}</p>
                  <p className="text-sm text-muted-foreground">{formatIDR(line.price)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="size-8" onClick={() => setQty(line.productId, line.qty - 1)}>
                    <Minus className="size-4" />
                  </Button>
                  <span className="w-8 text-center text-sm">{line.qty}</span>
                  <Button variant="outline" size="icon" className="size-8" onClick={() => setQty(line.productId, line.qty + 1)}>
                    <Plus className="size-4" />
                  </Button>
                </div>
                <Button variant="ghost" size="icon" className="size-8 text-destructive" onClick={() => remove(line.productId)}>
                  <Trash2 className="size-4" />
                </Button>
              </Card>
            ))}

            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="text-lg font-bold">{formatIDR(subtotal)}</span>
            </div>
            <Button asChild className="w-full" size="lg">
              <Link href="/checkout">Proceed to checkout</Link>
            </Button>
          </div>
        )}
      </section>
    </StorefrontShell>
  )
}
