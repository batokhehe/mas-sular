'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'

/**
 * Real category strip — fetched from the production `/catalog/categories` endpoint
 * (no mock data). Chips deep-link to the catalog filtered by category; the catalog
 * URL-param filter is wired in the Phase 3 catalog migration. Hidden when empty.
 */
export function CategoryStrip() {
  const { data: categories = [] } = useQuery({
    queryKey: qk.catalog.categories,
    queryFn: productsApi.categories,
  })

  if (categories.length === 0) return null

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8">
      <h2 className="mb-4 text-xl font-bold">Kategori</h2>
      <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {categories.map((c) => (
          <Link
            key={c.id}
            href={`/catalog?category=${encodeURIComponent(c.slug)}`}
            className="flex min-w-20 shrink-0 flex-col items-center gap-2 rounded-2xl border bg-card p-3 transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-xl">
              {c.icon || c.name.charAt(0).toUpperCase()}
            </span>
            <span className="whitespace-nowrap text-xs font-medium">{c.name}</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
