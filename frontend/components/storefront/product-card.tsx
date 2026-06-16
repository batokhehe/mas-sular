'use client'

import Link from 'next/link'
import { toast } from 'sonner'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore } from '@/lib/stores/cart-store'
import type { Product } from '@/lib/types/models'

export function ProductCard({ product }: { product: Product }) {
  const add = useCartStore((s) => s.add)
  const outOfStock = product.stock <= 0

  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <Link href={`/catalog/${product.slug}`} className="relative block aspect-square bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.imageUrl} alt={product.name} className="size-full object-cover" />
        {product.isBestSeller ? <Badge className="absolute left-2 top-2">Best seller</Badge> : null}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Link href={`/catalog/${product.slug}`}>
          <h3 className="line-clamp-1 font-semibold">{product.name}</h3>
        </Link>
        <p className="font-bold">{formatIDR(product.price)}</p>
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
