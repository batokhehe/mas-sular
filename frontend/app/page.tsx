'use client'

import { useProducts } from '@/lib/query/hooks'
import { StorefrontShell } from '@/components/storefront/shell'
import { HomeHero } from '@/components/storefront/home-hero'
import { BannerCarousel } from '@/components/storefront/banner-carousel'
import { PromoCarousel } from '@/components/storefront/promo-carousel'
import { ProductSection } from '@/components/storefront/product-section'
import { StorefrontSkeleton } from '@/components/layout/storefront/storefront-skeleton'
import { ErrorState } from '@/components/common/error-state'

export default function HomePage() {
  const { data, isLoading, isError, refetch } = useProducts({})
  const products = data ?? []
  // P2 #10: products an admin flagged isPromoSpecial, filtered by the catalog API
  // (same visibility rules as every listing). Not the voucher carousel above -
  // that stays "Promo Spesial" (promo codes); this is "Promo Spesial Produk".
  const promoSpecialQuery = useProducts({ promoSpecial: true })
  const promoSpecial = (promoSpecialQuery.data ?? []).filter((p) => p.isPromoSpecial).slice(0, 8)
  // P2 #11: products flagged isTrialPack - same pattern as Promo Special.
  const trialPackQuery = useProducts({ trialPack: true })
  const trialPack = (trialPackQuery.data ?? []).filter((p) => p.isTrialPack).slice(0, 8)
  const bestSellers = products.filter((p) => p.isBestSeller).slice(0, 8)
  const latest = products.filter((p) => p.isNew).slice(0, 8)
  const featured = products.slice(0, 8)

  return (
    <StorefrontShell>
      <HomeHero />
      <BannerCarousel />
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
            <ProductSection title="Promo Spesial Produk" products={promoSpecial} />
            <ProductSection title="Trial Pack" products={trialPack} />
            <ProductSection title="Best Sellers" products={bestSellers} viewAllHref="/catalog" />
            <ProductSection title="New Arrivals" products={latest} viewAllHref="/catalog" />
            <ProductSection title="All Products" products={featured} viewAllHref="/catalog" />
          </>
        )}
      </div>
    </StorefrontShell>
  )
}
