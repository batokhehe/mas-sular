'use client'

import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Search, SlidersHorizontal, X } from 'lucide-react'
import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { FloatingCart } from '@/components/floating-cart'
import { CategorySection } from '@/components/category-section'
import { ProductCard } from '@/components/product-card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useProducts, useCategories } from '@/hooks/api'

type SortOption = 'popular' | 'price-low' | 'price-high' | 'rating'

const sortOptions: { value: SortOption; label: string }[] = [
  { value: 'popular', label: 'Paling Populer' },
  { value: 'price-low', label: 'Harga Terendah' },
  { value: 'price-high', label: 'Harga Tertinggi' },
  { value: 'rating', label: 'Rating Tertinggi' },
]

export default function MenuPage() {
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortOption>('popular')
  const [showFilters, setShowFilters] = useState(false)

  // Fetch products from API
  const { data: products = [], isLoading, error } = useProducts({
    search: search || undefined,
    category: selectedCategory || undefined,
    sort: sortBy,
  })

  // Fetch categories from API
  const { data: categories = [] } = useCategories()

  // Client-side filtering/sorting (API already handles sorting and search)
  const filteredProducts = useMemo(() => {
    return products
  }, [products])

  const activeFiltersCount = [selectedCategory, search].filter(Boolean).length

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <Navbar />
      <main className="container py-4">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-2xl font-bold mb-1">Menu</h1>
          <p className="text-muted-foreground text-sm">
            Pilih bakso favorit Anda
          </p>
        </div>

        {/* Search & Filter */}
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Cari bakso..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
          </div>
          <Sheet open={showFilters} onOpenChange={setShowFilters}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="relative shrink-0">
                <SlidersHorizontal className="h-4 w-4" />
                {activeFiltersCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px]">
                    {activeFiltersCount}
                  </span>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="h-[70vh] rounded-t-3xl">
              <SheetHeader>
                <SheetTitle>Filter & Urutkan</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-6">
                {/* Sort */}
                <div>
                  <h3 className="font-medium mb-3">Urutkan</h3>
                  <div className="flex flex-wrap gap-2">
                    {sortOptions.map((option) => (
                      <Button
                        key={option.value}
                        variant={sortBy === option.value ? 'default' : 'outline'}
                        size="sm"
                        className="rounded-full"
                        onClick={() => {
                          setSortBy(option.value)
                          setShowFilters(false)
                        }}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Categories */}
                <div>
                  <h3 className="font-medium mb-3">Kategori</h3>
                  <div className="flex flex-wrap gap-2">
                    {categories.map((category) => (
                      <Button
                        key={category.id}
                        variant={selectedCategory === category.slug ? 'default' : 'outline'}
                        size="sm"
                        className="rounded-full"
                        onClick={() => {
                          setSelectedCategory(
                            selectedCategory === category.slug ? null : category.slug
                          )
                          setShowFilters(false)
                        }}
                      >
                        {category.name}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Clear All */}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setSearch('')
                    setSelectedCategory(null)
                    setSortBy('popular')
                    setShowFilters(false)
                  }}
                >
                  Hapus Semua Filter
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>

        {/* Error State */}
        {error && (
          <div className="mb-4 p-4 bg-destructive/10 text-destructive rounded-lg text-sm">
            Gagal memuat produk. Silakan coba lagi.
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-2xl bg-secondary/50 aspect-square animate-pulse" />
            ))}
          </div>
        )}

        {/* Products Grid */}
        {!isLoading && filteredProducts.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
            {filteredProducts.map((product, index) => (
              <ProductCard key={product.id} product={product} index={index} />
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && filteredProducts.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Tidak ada produk yang sesuai dengan filter Anda</p>
          </div>
        )}
      </main>
      <FloatingCart />
      <BottomNav />
    </div>
  )
}
