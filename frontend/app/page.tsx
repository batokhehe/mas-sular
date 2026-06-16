'use client'

import Link from 'next/link'
import { useProducts } from '@/lib/query/hooks'
import { StorefrontShell } from '@/components/storefront/shell'
import { ProductCard } from '@/components/storefront/product-card'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import type { Product } from '@/lib/types/models'

function Section({ title, products }: { title: string; products: Product[] }) {
  if (products.length === 0) return null
  return (
    <div>
      <h2 className="mb-4 text-xl font-bold">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </div>
  )
}

export default function HomePage() {
  const { data, isLoading, isError, refetch } = useProducts({})
  const products = data ?? []
  const featured = products.slice(0, 8)
  const bestSellers = products.filter((p) => p.isBestSeller).slice(0, 4)
  const latest = products.filter((p) => p.isNew).slice(0, 4)

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-10 rounded-2xl bg-primary/10 p-8 text-center sm:p-12">
          <h1 className="text-2xl font-bold sm:text-4xl">Premium Indonesian Meatballs</h1>
          <p className="mt-2 text-muted-foreground">Fresh bakso, delivered to your door.</p>
          <Button asChild className="mt-5">
            <Link href="/catalog">Browse catalog</Link>
          </Button>
        </div>

        {isLoading ? (
          <StorefrontSkeleton />
        ) : isError ? (
          <ErrorState description="Could not load products." onRetry={() => void refetch()} />
        ) : (
          <div className="space-y-12">
            <Section title="Featured" products={featured} />
            <Section title="Best Sellers" products={bestSellers} />
            <Section title="Latest" products={latest} />
          </div>
        )}
      </section>
    </StorefrontShell>
  )
}
