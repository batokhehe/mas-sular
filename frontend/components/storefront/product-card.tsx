'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { Star, Flame, Minus, Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore } from '@/lib/stores/cart-store'
import { cardCartState, plainLineId } from '@/lib/cart/card-quantity'
import type { Product } from '@/lib/types/models'

export function ProductCard({ product }: { product: Product }) {
  const add = useCartStore((s) => s.add)
  const setQty = useCartStore((s) => s.setQty)
  const lines = useCartStore((s) => s.lines)
  // "Tambahkan" until the product's plain line is in the (shared, persisted) cart,
  // then `− qty +` on that same line. Stock is per product across all its lines.
  const cartState = cardCartState(lines, product.id, product.availableStock)

  // All derived from real Product fields — no fabricated values.
  const discount =
    product.originalPrice && product.originalPrice > product.price
      ? Math.round((1 - product.price / product.originalPrice) * 100)
      : 0
  const spicy = product.spicyLevel ?? 0
  const reviews = product.reviewCount

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      {/*
        P2 #4: the image area is ALWAYS a square set by the card's width. The <img> is
        taken out of flow (absolute) so its intrinsic size cannot take part in layout -
        before, a portrait source image pushed this "square" taller (aspect-ratio is
        only a preferred size) and the grid row stretched every neighbouring card.
        object-cover keeps the existing look: fills the square, never distorts.
      */}
      <Link href={`/catalog/${product.slug}`} className="relative block aspect-square overflow-hidden bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.imageUrl} alt={product.name} className="absolute inset-0 size-full object-cover" />

        {/* Badges (real flags) */}
        <div className="absolute left-2 top-2 flex flex-col gap-1">
          {product.isBestSeller ? <Badge>Terlaris</Badge> : null}
          {product.isNew ? <Badge variant="secondary">Baru</Badge> : null}
          {discount > 0 ? <Badge variant="destructive">-{discount}%</Badge> : null}
        </div>

        {/* Spicy level (real spicyLevel) */}
        {spicy > 0 ? (
          <div
            className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-full bg-background/80 px-2 py-1 backdrop-blur-sm"
            aria-label={`Level pedas ${spicy}`}
          >
            {Array.from({ length: spicy }).map((_, i) => (
              <Flame key={i} className="size-3 fill-primary text-primary" />
            ))}
          </div>
        ) : null}
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <Link href={`/catalog/${product.slug}`}>
          <h3 className="line-clamp-1 font-semibold">{product.name}</h3>
        </Link>

        {/* Rating + review count — only when there are real reviews */}
        {reviews > 0 ? (
          <div className="flex items-center gap-1 text-xs">
            <Star className="size-3.5 fill-yellow-400 text-yellow-400" />
            <span className="font-medium">{Number(product.rating).toFixed(1)}</span>
            <span className="text-muted-foreground">({reviews})</span>
          </div>
        ) : null}

        {/* Price (+ original price strikethrough when discounted) */}
        <div className="flex items-baseline gap-2">
          <p className="font-bold">{formatIDR(product.price)}</p>
          {product.originalPrice && product.originalPrice > product.price ? (
            <p className="text-xs text-muted-foreground line-through">{formatIDR(product.originalPrice)}</p>
          ) : null}
        </div>

        {cartState.mode === 'counter' ? (
          <div
            role="group"
            aria-label={`Jumlah ${product.name} di keranjang`}
            className="mt-auto flex w-full items-center justify-between rounded-full bg-secondary p-1"
          >
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              // Quantity 0 removes the line (cart store setQty) and the card shows "Tambahkan" again.
              onClick={() => setQty(plainLineId(product.id), cartState.qty - 1)}
              aria-label={`Kurangi ${product.name}`}
            >
              <Minus className="size-3.5" />
            </Button>
            <span className="min-w-7 text-center text-sm font-semibold" aria-live="polite">
              {cartState.qty}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              disabled={!cartState.canIncrement}
              onClick={() => add(product)}
              aria-label={`Tambah ${product.name}`}
            >
              <Plus className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="mt-auto w-full"
            disabled={!cartState.canIncrement}
            onClick={() => {
              add(product)
              toast.success('Ditambahkan ke keranjang')
            }}
          >
            {cartState.mode === 'soldout' ? 'Stok Habis' : cartState.mode === 'full' ? 'Stok di keranjang penuh' : 'Tambahkan'}
          </Button>
        )}
        {/* Lines with add-ons are edited on the product page / in the cart, not here. */}
        {cartState.addOnQty > 0 ? (
          <p className="text-center text-xs text-muted-foreground">+{cartState.addOnQty} dengan tambahan di keranjang</p>
        ) : null}
      </div>
    </Card>
  )
}
