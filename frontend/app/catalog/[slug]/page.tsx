'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Star, Flame, Minus, Plus, ShoppingCart, ChevronLeft } from 'lucide-react'
import { productsApi } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'
import { useProducts, useToppings } from '@/lib/query/hooks'
import { StorefrontShell } from '@/components/storefront/shell'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'
import { ProductCard } from '@/components/storefront/product-card'
import { ProductGallery } from '@/components/storefront/product-gallery'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatIDR } from '@/lib/utils/format'
import { Checkbox } from '@/components/ui/checkbox'
import { useCartStore, toppingsTotal } from '@/lib/stores/cart-store'

export default function ProductDetailPage() {
  const params = useParams<{ slug: string }>()
  const slug = params?.slug
  const add = useCartStore((s) => s.add)
  const [qty, setQty] = useState(1)
  const [toppingIds, setToppingIds] = useState<string[]>([])

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

  // Toppings are global in the catalog (no per-product eligibility exists in the
  // schema). Only what GET /catalog/toppings returns - active ones - can be chosen;
  // while it loads or if it fails there is simply no selector (a plain add still
  // works). The order endpoint re-validates and reprices every topping.
  const toppingsQuery = useToppings()
  const availableToppings = toppingsQuery.data ?? []
  const chosenToppings = availableToppings.filter((t) => toppingIds.includes(t.id))
  const unitPrice = (product?.price ?? 0) + toppingsTotal(chosenToppings)
  const toggleTopping = (id: string, checked: boolean) =>
    setToppingIds((ids) => (checked ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)))
  // A different product starts with no toppings chosen.
  useEffect(() => setToppingIds([]), [product?.id])

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-5xl px-4 py-8">
        <Link
          href="/catalog"
          className="mb-6 inline-flex items-center text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="mr-1 size-4" /> Kembali ke katalog
        </Link>

        {isLoading ? (
          <StorefrontSkeleton />
        ) : isError || !product ? (
          <ErrorState description="Produk tidak ditemukan." onRetry={() => void refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
              {/* Image gallery (P2) + real badges over the main image */}
              <ProductGallery
                product={product}
                overlay={
                  <div className="pointer-events-none absolute left-4 top-4 flex flex-col gap-2">
                    {product.isBestSeller ? <Badge>Terlaris</Badge> : null}
                    {product.isNew ? <Badge variant="secondary">Baru</Badge> : null}
                    {discount > 0 ? <Badge variant="destructive">-{discount}%</Badge> : null}
                  </div>
                }
              />

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
                        <span className="text-muted-foreground">({product.reviewCount} ulasan)</span>
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
                  <dt className="text-muted-foreground">Stok</dt>
                  <dd>{product.stock > 0 ? `${product.stock} tersedia` : 'Stok Habis'}</dd>
                </dl>

                <div>
                  <h3 className="mb-1 font-semibold">Deskripsi</h3>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
                    {product.description}
                  </p>
                </div>

                {!outOfStock && availableToppings.length > 0 ? (
                  <fieldset>
                    <legend className="mb-2 font-semibold">
                      Topping <span className="text-sm font-normal text-muted-foreground">(opsional)</span>
                    </legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {availableToppings.map((topping) => (
                        <label
                          key={topping.id}
                          htmlFor={`topping-${topping.id}`}
                          className="flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                        >
                          <Checkbox
                            id={`topping-${topping.id}`}
                            checked={toppingIds.includes(topping.id)}
                            onCheckedChange={(checked) => toggleTopping(topping.id, checked === true)}
                          />
                          <span className="flex-1 font-medium">{topping.name}</span>
                          <span className="text-muted-foreground">+{formatIDR(topping.price)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}

                {/* Quantity + add to cart — the real cart store supports qty. */}
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <div className="flex items-center gap-2 rounded-full bg-secondary p-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-9 rounded-full"
                      disabled={outOfStock}
                      onClick={() => setQty((q) => Math.max(1, q - 1))}
                      aria-label="Kurangi jumlah"
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
                      aria-label="Tambah jumlah"
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                  <Button
                    className="flex-1 rounded-full sm:flex-none"
                    disabled={outOfStock}
                    onClick={() => {
                      add(product, qty, chosenToppings)
                      toast.success('Ditambahkan ke keranjang')
                    }}
                  >
                    <ShoppingCart className="mr-2 size-4" />
                    {outOfStock ? 'Stok Habis' : `Tambah ke Keranjang · ${formatIDR(unitPrice * qty)}`}
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
