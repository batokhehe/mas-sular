'use client'

import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { productsApi } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'
import { StorefrontShell } from '@/components/storefront/shell'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore } from '@/lib/stores/cart-store'

export default function ProductDetailPage() {
  const params = useParams<{ slug: string }>()
  const slug = params?.slug
  const add = useCartStore((s) => s.add)

  const { data: product, isLoading, isError, refetch } = useQuery({
    queryKey: qk.catalog.product(slug ?? ''),
    queryFn: () => productsApi.detail(slug as string),
    enabled: !!slug,
  })

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-5xl px-4 py-8">
        {isLoading ? (
          <StorefrontSkeleton />
        ) : isError || !product ? (
          <ErrorState description="Product not found." onRetry={() => void refetch()} />
        ) : (
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
            <div className="overflow-hidden rounded-2xl border bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={product.imageUrl} alt={product.name} className="aspect-square w-full object-cover" />
            </div>
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">{product.name}</h1>
                {product.isBestSeller ? <Badge>Best seller</Badge> : null}
              </div>
              <p className="text-2xl font-bold">{formatIDR(product.price)}</p>
              {product.originalPrice ? (
                <p className="text-sm text-muted-foreground line-through">{formatIDR(product.originalPrice)}</p>
              ) : null}
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">Stock</dt>
                <dd>{product.stock > 0 ? `${product.stock} available` : 'Out of stock'}</dd>
                <dt className="text-muted-foreground">Weight</dt>
                <dd>~500 g / item</dd>
                <dt className="text-muted-foreground">SKU</dt>
                <dd>{product.sku}</dd>
              </dl>
              <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                {product.description}
              </p>
              <Button
                className="w-full sm:w-auto"
                disabled={product.stock <= 0}
                onClick={() => {
                  add(product)
                  toast.success('Added to cart')
                }}
              >
                {product.stock > 0 ? 'Add to cart' : 'Out of stock'}
              </Button>
            </div>
          </div>
        )}
      </section>
    </StorefrontShell>
  )
}
