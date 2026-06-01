import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { FloatingCart } from '@/components/floating-cart'
import { HeroBanner } from '@/components/hero-banner'
import { CategorySection } from '@/components/category-section'
import { PromoCarousel } from '@/components/promo-carousel'
import { HomeContent } from '@/components/home-content'

export default function HomePage() {
  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <Navbar />
      <main>
        <HeroBanner />
        <CategorySection />
        <PromoCarousel />
        <HomeContent />
      </main>
      <FloatingCart />
      <BottomNav />
    </div>
  )
}
