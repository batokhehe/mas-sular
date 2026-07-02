'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Search, X, Loader2 } from 'lucide-react'
import { useProducts } from '@/lib/query/hooks'
import { productsApi, type ProductQuery } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'
import { StorefrontShell } from '@/components/storefront/shell'
import { ProductCard } from '@/components/storefront/product-card'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { Empty } from '@/components/common/empty'
import { ErrorState } from '@/components/common/error-state'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const PAGE_SIZE = 8

type SortValue = NonNullable<ProductQuery['sort']> | 'default'
const SORT_OPTIONS: { value: SortValue; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'popular', label: 'Paling Populer' },
  { value: 'price-low', label: 'Harga Terendah' },
  { value: 'price-high', label: 'Harga Tertinggi' },
  { value: 'rating', label: 'Rating Tertinggi' },
]

function chipClass(active: boolean): string {
  return cn(
    'shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition-colors',
    active ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/50',
  )
}

function CatalogInner() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // Category is URL-driven so Home chips (/catalog?category=slug) work end-to-end
  // and the filter is shareable. Search + sort are real React query state that
  // drives useProducts (and therefore the backend request).
  const category = sp.get('category') ?? 'all'
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortValue>('default')
  const [page, setPage] = useState(1)

  const categoriesQuery = useQuery({ queryKey: qk.catalog.categories, queryFn: productsApi.categories })

  // Every control maps to a real backend query param — no client-side filtering/sorting.
  const { data, isLoading, isError, refetch } = useProducts({
    search: search || undefined,
    category: category === 'all' ? undefined : category,
    sort: sort === 'default' ? undefined : sort,
  })

  const products = data ?? []
  const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const pageItems = useMemo(
    () => products.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [products, safePage],
  )

  // Reset to first page whenever any filter changes (incl. URL-driven category).
  useEffect(() => {
    setPage(1)
  }, [category, search, sort])

  const setCategory = (value: string) => {
    const params = new URLSearchParams(sp.toString())
    if (value === 'all') params.delete('category')
    else params.set('category', value)
    const queryString = params.toString()
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false })
  }

  const categories = categoriesQuery.data ?? []
  const activeCategoryName = categories.find((c) => c.slug === category)?.name

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-4">
          <h1 className="text-2xl font-bold">Catalog</h1>
          <p className="text-sm text-muted-foreground">Pilih bakso favorit Anda</p>
        </div>

        {/* Search + sort */}
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Cari bakso…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
            {search ? (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                aria-label="Clear search"
              >
                <X className="size-4 text-muted-foreground" />
              </button>
            ) : null}
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortValue)}>
            <SelectTrigger className="sm:w-52">
              <SelectValue placeholder="Urutkan" />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Category chips (real categories from the backend) */}
        <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
          <button onClick={() => setCategory('all')} className={chipClass(category === 'all')}>
            Semua
          </button>
          {categories.map((c) => (
            <button key={c.id} onClick={() => setCategory(c.slug)} className={chipClass(category === c.slug)}>
              {c.icon ? <span className="mr-1">{c.icon}</span> : null}
              {c.name}
            </button>
          ))}
        </div>

        {/* Active filters */}
        {category !== 'all' || search ? (
          <div className="mb-4 flex flex-wrap gap-2">
            {category !== 'all' ? (
              <Badge variant="secondary" className="gap-1">
                {activeCategoryName ?? category}
                <button onClick={() => setCategory('all')} aria-label="Clear category filter">
                  <X className="size-3" />
                </button>
              </Badge>
            ) : null}
            {search ? (
              <Badge variant="secondary" className="gap-1">
                &quot;{search}&quot;
                <button onClick={() => setSearch('')} aria-label="Clear search filter">
                  <X className="size-3" />
                </button>
              </Badge>
            ) : null}
          </div>
        ) : null}

        {isLoading ? (
          <StorefrontSkeleton />
        ) : isError ? (
          <ErrorState description="Could not load products." onRetry={() => void refetch()} />
        ) : products.length === 0 ? (
          <Empty title="No products found" description="Try a different search or category." />
        ) : (
          <>
            {/* Real count from the fetched list — not a fabricated figure. */}
            <p className="mb-4 text-sm text-muted-foreground">{products.length} produk ditemukan</p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {pageItems.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {safePage} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={safePage >= pageCount}
                onClick={() => setPage(safePage + 1)}
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

export default function CatalogPage() {
  return (
    <Suspense
      fallback={
        <StorefrontShell>
          <div className="flex min-h-[40vh] items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        </StorefrontShell>
      }
    >
      <CatalogInner />
    </Suspense>
  )
}
