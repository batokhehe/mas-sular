'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProductCard } from './product-card'
import { type Product } from '@/lib/types'
import { products, type Product as DataProduct } from '@/lib/data'

interface ProductGridProps {
  title?: string
  // Accept either Product shape (the static data set uses its own interface),
  // mirroring what ProductCard already accepts.
  products: (Product | DataProduct)[]
  showViewAll?: boolean
  viewAllHref?: string
  columns?: 2 | 3 | 4
  isLoading?: boolean
}

export function ProductGrid({
  title,
  products: productList,
  showViewAll = false,
  viewAllHref = '/menu',
  columns = 2,
  isLoading = false,
}: ProductGridProps) {
  const gridCols = {
    2: 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    3: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
  }

  if (isLoading) {
    return (
      <section className="py-6">
        <div className="container">
          {title && (
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg sm:text-xl font-bold">{title}</h2>
            </div>
          )}
          <div className={`grid ${gridCols[columns]} gap-3 sm:gap-4`}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-2xl bg-secondary/50 aspect-square animate-pulse" />
            ))}
          </div>
        </div>
      </section>
    )
  }

  if (!productList || productList.length === 0) {
    return (
      <section className="py-6">
        <div className="container">
          {title && (
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg sm:text-xl font-bold">{title}</h2>
            </div>
          )}
          <div className="text-center py-12">
            <p className="text-muted-foreground">Tidak ada produk</p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="py-6">
      <div className="container">
        {title && (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg sm:text-xl font-bold">{title}</h2>
            {showViewAll && (
              <Link href={viewAllHref}>
                <Button variant="ghost" size="sm" className="text-primary">
                  Lihat Semua
                  <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </Link>
            )}
          </div>
        )}

        <div className={`grid ${gridCols[columns]} gap-3 sm:gap-4`}>
          {productList.map((product, index) => (
            <ProductCard key={product.id} product={product} index={index} />
          ))}
        </div>
      </div>
    </section>
  )
}

export function BestSellerSection() {
  const bestSellers = products.filter((p) => p.isBestSeller)

  return (
    <ProductGrid
      title="Best Seller"
      products={bestSellers}
      showViewAll
      viewAllHref="/menu?filter=bestseller"
    />
  )
}

export function NewArrivalsSection() {
  const newProducts = products.filter((p) => p.isNew)

  if (newProducts.length === 0) return null

  return (
    <ProductGrid
      title="Menu Baru"
      products={newProducts}
      showViewAll
      viewAllHref="/menu?filter=new"
    />
  )
}
