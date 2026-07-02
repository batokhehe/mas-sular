'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { Star, Flame } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore } from '@/lib/stores/cart-store'
import type { Product } from '@/lib/types/models'

export function ProductCard({ product }: { product: Product }) {
  const add = useCartStore((s) => s.add)
  const outOfStock = product.stock <= 0

  // All derived from real Product fields — no fabricated values.
  const discount =
    product.originalPrice && product.originalPrice > product.price
      ? Math.round((1 - product.price / product.originalPrice) * 100)
      : 0
  const spicy = product.spicyLevel ?? 0
  const reviews = product.reviewCount

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <Link href={`/catalog/${product.slug}`} className="relative block aspect-square bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.imageUrl} alt={product.name} className="size-full object-cover" />

        {/* Badges (real flags) */}
        <div className="absolute left-2 top-2 flex flex-col gap-1">
          {product.isBestSeller ? <Badge>Best seller</Badge> : null}
          {product.isNew ? <Badge variant="secondary">New</Badge> : null}
          {discount > 0 ? <Badge variant="destructive">-{discount}%</Badge> : null}
        </div>

        {/* Spicy level (real spicyLevel) */}
        {spicy > 0 ? (
          <div
            className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-full bg-background/80 px-2 py-1 backdrop-blur-sm"
            aria-label={`Spicy level ${spicy}`}
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

        <Button
          size="sm"
          className="mt-auto w-full"
          disabled={outOfStock}
          onClick={() => {
            add(product)
            toast.success('Added to cart')
          }}
        >
          {outOfStock ? 'Out of stock' : 'Add to cart'}
        </Button>
      </div>
    </Card>
  )
}
