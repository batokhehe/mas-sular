import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { ProductCard } from '@/components/storefront/product-card'
import type { Product } from '@/lib/types/models'

/**
 * Reusable storefront product section: heading + optional "View all" link + a
 * responsive grid of the real ProductCard. Products are supplied by the caller
 * (powered by useProducts / real API). Renders nothing when there are no products
 * — no placeholder/skeleton content here.
 */
export function ProductSection({
  title,
  products,
  viewAllHref,
}: {
  title: string
  products: Product[]
  viewAllHref?: string
}) {
  if (products.length === 0) return null

  return (
    <section className="mx-auto max-w-6xl px-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold">{title}</h2>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="inline-flex shrink-0 items-center text-sm font-medium text-primary hover:underline"
          >
            View all
            <ChevronRight className="ml-0.5 size-4" />
          </Link>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </section>
  )
}
