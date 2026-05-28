'use client'

import { motion } from 'framer-motion'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProductCard } from './product-card'
import { products, type Product } from '@/lib/data'

interface ProductGridProps {
  title?: string
  products?: Product[]
  showViewAll?: boolean
  viewAllHref?: string
  columns?: 2 | 3 | 4
}

export function ProductGrid({
  title,
  products: productList = products,
  showViewAll = false,
  viewAllHref = '/menu',
  columns = 2,
}: ProductGridProps) {
  const gridCols = {
    2: 'grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    3: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4',
    4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
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
