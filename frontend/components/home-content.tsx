'use client'

import { ProductGrid } from './product-grid'
import { useProducts } from '@/hooks/api'

export function HomeContent() {
  // Fetch best sellers
  const { data: bestSellers = [], isLoading: loadingBestSellers } = useProducts({
    sort: 'popular',
  })

  // Fetch new arrivals
  const { data: allProducts = [], isLoading: loadingAll } = useProducts({
    sort: 'popular',
  })

  const newArrivals = allProducts.filter((p) => p.isNew)
  const bestSellerProducts = bestSellers.filter((p) => p.isBestSeller)

  return (
    <>
      <ProductGrid
        title="Best Seller"
        products={bestSellerProducts}
        showViewAll
        viewAllHref="/menu?sort=popular"
        isLoading={loadingBestSellers}
      />
      {newArrivals.length > 0 && (
        <ProductGrid
          title="Menu Baru"
          products={newArrivals}
          showViewAll
          viewAllHref="/menu?sort=popular"
          isLoading={loadingAll}
        />
      )}
      <ProductGrid
        title="Semua Menu"
        products={allProducts}
        showViewAll
        viewAllHref="/menu"
        isLoading={loadingAll}
      />
    </>
  )
}
