'use client'

import { useProducts } from '@/lib/query/hooks'
import { StorefrontShell } from '@/components/storefront/shell'
import { HomeHero } from '@/components/storefront/home-hero'
import { BannerCarousel } from '@/components/storefront/banner-carousel'
import { CategoryStrip } from '@/components/storefront/category-strip'
import { PromoCarousel } from '@/components/storefront/promo-carousel'
import { ProductSection } from '@/components/storefront/product-section'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'

export default function HomePage() {
  const { data, isLoading, isError, refetch } = useProducts({})
  const products = data ?? []
  const bestSellers = products.filter((p) => p.isBestSeller).slice(0, 8)
  const latest = products.filter((p) => p.isNew).slice(0, 8)
  const featured = products.slice(0, 8)

  return (
    <StorefrontShell>
      <HomeHero />
      <BannerCarousel />
      <CategoryStrip />
      <PromoCarousel />

      <div className="space-y-12 py-10">
        {isLoading ? (
          <div className="mx-auto max-w-6xl px-4">
            <StorefrontSkeleton />
          </div>
        ) : isError ? (
          <div className="mx-auto max-w-6xl px-4">
            <ErrorState description="Could not load products." onRetry={() => void refetch()} />
          </div>
        ) : (
          <>
            <ProductSection title="Best Sellers" products={bestSellers} viewAllHref="/catalog" />
            <ProductSection title="New Arrivals" products={latest} viewAllHref="/catalog" />
            <ProductSection title="All Products" products={featured} viewAllHref="/catalog" />
          </>
        )}
      </div>
    </StorefrontShell>
  )
}
