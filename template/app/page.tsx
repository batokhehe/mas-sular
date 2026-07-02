import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { FloatingCart } from '@/components/floating-cart'
import { HeroBanner } from '@/components/hero-banner'
import { CategorySection } from '@/components/category-section'
import { PromoCarousel } from '@/components/promo-carousel'
import { BestSellerSection, NewArrivalsSection, ProductGrid } from '@/components/product-grid'
import { products } from '@/lib/data'

export default function HomePage() {
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <Navbar />
      <main>
        <HeroBanner />
        <CategorySection />
        <PromoCarousel />
        <BestSellerSection />
        <NewArrivalsSection />
        <ProductGrid title="Semua Menu" products={products} showViewAll viewAllHref="/menu" />
      </main>
      <FloatingCart />
      <BottomNav />
    </div>
  )
}
