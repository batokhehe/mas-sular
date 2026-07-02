'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Star, Flame, Minus, Plus, ShoppingCart, ChevronLeft } from 'lucide-react'
import { productsApi } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'
import { useProducts } from '@/lib/query/hooks'
import { StorefrontShell } from '@/components/storefront/shell'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'
import { ProductCard } from '@/components/storefront/product-card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { useCartStore } from '@/lib/stores/cart-store'

export default function ProductDetailPage() {
  const params = useParams<{ slug: string }>()
  const slug = params?.slug
  const add = useCartStore((s) => s.add)
  const [qty, setQty] = useState(1)

  const { data: product, isLoading, isError, refetch } = useQuery({
    queryKey: qk.catalog.product(slug ?? ''),
    queryFn: () => productsApi.detail(slug as string),
    enabled: !!slug,
  })

  // Real related products: same category, current excluded.
  const relatedQuery = useProducts({ category: product?.category?.slug })
  const related = (relatedQuery.data ?? []).filter((p) => p.id !== product?.id).slice(0, 4)

  const discount = product?.originalPrice
    ? Math.round((1 - product.price / product.originalPrice) * 100)
    : 0
  const spicy = product?.spicyLevel ?? 0
  const outOfStock = (product?.stock ?? 0) <= 0

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-5xl px-4 py-8">
        <Link
          href="/catalog"
          className="mb-6 inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="mr-1 size-4" /> Back to catalog
        </Link>

        {isLoading ? (
          <StorefrontSkeleton />
        ) : isError || !product ? (
          <ErrorState description="Product not found." onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
              {/* Image + real badges */}
              <div className="relative overflow-hidden rounded-2xl border bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={product.imageUrl} alt={product.name} className="aspect-square w-full object-cover" />
                <div className="absolute left-4 top-4 flex flex-col gap-2">
                  {product.isBestSeller ? <Badge>Best seller</Badge> : null}
                  {product.isNew ? <Badge variant="secondary">New</Badge> : null}
                  {discount > 0 ? <Badge variant="destructive">-{discount}%</Badge> : null}
                </div>
              </div>

              {/* Details */}
              <div className="space-y-4">
                <h1 className="text-2xl font-bold sm:text-3xl">{product.name}</h1>

                {/* Real rating + spicy level (display only; shown when present) */}
                {product.reviewCount > 0 || spicy > 0 ? (
                  <div className="flex items-center gap-4 text-sm">
                    {product.reviewCount > 0 ? (
                      <span className="flex items-center gap-1">
                        <Star className="size-4 fill-yellow-400 text-yellow-400" />
                        <span className="font-medium">{Number(product.rating).toFixed(1)}</span>
                        <span className="text-muted-foreground">({product.reviewCount} reviews)</span>
                      </span>
                    ) : null}
                    {spicy > 0 ? (
                      <span className="flex items-center gap-0.5" aria-label={`Spicy level ${spicy}`}>
                        {Array.from({ length: spicy }).map((_, i) => (
                          <Flame key={i} className="size-4 fill-primary text-primary" />
                        ))}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex items-baseline gap-3">
                  <span className="text-2xl font-bold text-primary sm:text-3xl">{formatIDR(product.price)}</span>
                  {product.originalPrice ? (
                    <span className="text-lg text-muted-foreground line-through">{formatIDR(product.originalPrice)}</span>
                  ) : null}
                </div>

                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">Stock</dt>
                  <dd>{product.stock > 0 ? `${product.stock} available` : 'Out of stock'}</dd>
                  <dt className="text-muted-foreground">SKU</dt>
                  <dd>{product.sku}</dd>
                </dl>

                <div>
                  <h3 className="mb-1 font-semibold">Description</h3>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {product.description}
                  </p>
                </div>

                {/* Quantity + add to cart — the real cart store supports qty. */}
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <div className="flex items-center gap-2 rounded-full bg-secondary p-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-full"
                      disabled={outOfStock}
                      onClick={() => setQty((q) => Math.max(1, q - 1))}
                      aria-label="Decrease quantity"
                    >
                      <Minus className="size-4" />
                    </Button>
                    <span className="w-8 text-center font-semibold">{qty}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-full"
                      disabled={outOfStock}
                      onClick={() => setQty((q) => q + 1)}
                      aria-label="Increase quantity"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                  <Button
                    className="flex-1 rounded-full sm:flex-none"
                    disabled={outOfStock}
                    onClick={() => {
                      add(product, qty)
                      toast.success('Added to cart')
                    }}
                  >
                    <ShoppingCart className="mr-2 size-4" />
                    {outOfStock ? 'Out of stock' : `Add to cart · ${formatIDR(product.price * qty)}`}
                  </Button>
                </div>
              </div>
            </div>

            {/* Related products (real, same category) */}
            {related.length > 0 ? (
              <div className="mt-12">
                <h2 className="mb-4 text-xl font-bold">Produk Serupa</h2>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {related.map((p) => (
                    <ProductCard key={p.id} product={p} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </StorefrontShell>
  )
}
