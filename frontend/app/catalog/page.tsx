'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useProducts } from '@/lib/query/hooks'
import { productsApi } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'
import { StorefrontShell } from '@/components/storefront/shell'
import { ProductCard } from '@/components/storefront/product-card'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { Empty } from '@/components/common/empty'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const PAGE_SIZE = 8

export default function CatalogPage() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(1)

  const categoriesQuery = useQuery({ queryKey: qk.catalog.categories, queryFn: productsApi.categories })
  const { data, isLoading } = useProducts({
    search: search || undefined,
    category: category === 'all' ? undefined : category,
  })

  const products = data ?? []
  const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE))
  const pageItems = useMemo(
    () => products.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [products, page],
  )

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="mb-4 text-2xl font-bold">Catalog</h1>

        <div className="mb-6 flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="Search products…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            className="sm:max-w-xs"
          />
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v)
              setPage(1)
            }}
          >
            <SelectTrigger className="sm:w-52">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {(categoriesQuery.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.slug}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <StorefrontSkeleton />
        ) : pageItems.length === 0 ? (
          <Empty title="No products found" description="Try a different search or category." />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {pageItems.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </>
        )}
      </section>
    </StorefrontShell>
  )
}
