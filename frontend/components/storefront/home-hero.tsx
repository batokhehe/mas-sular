import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Storefront hero. Visual design migrated from the template, with all fabricated
 * stats/promo cards removed — copy only, no fake counters/ratings/figures.
 */
export function HomeHero() {
  return (
    <section className="relative overflow-hidden border-b bg-gradient-to-br from-primary/10 via-background to-secondary/30">
      <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 lg:grid-cols-2 lg:py-16">
        <div className="text-center lg:text-left">
          <span className="mb-4 inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-1.5 text-sm font-medium text-primary">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
            Diantar fresh setiap hari
          </span>

          <h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">
            Bakso Premium <span className="text-primary">Asli Nusantara</span>
          </h1>

          <p className="mx-auto mt-4 max-w-lg text-pretty text-muted-foreground lg:mx-0">
            Nikmati kelezatan bakso berkualitas tinggi dengan daging sapi pilihan, langsung diantar ke rumah Anda.
          </p>

          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
            <Button asChild size="lg" className="rounded-full">
              <Link href="/catalog">
                Pesan Sekarang
                <ChevronRight className="ml-1 size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-full">
              <Link href="/catalog">Lihat Menu</Link>
            </Button>
          </div>
        </div>

        {/* Decorative panel (no data/claims). */}
        <div className="relative hidden lg:block">
          <div className="relative mx-auto aspect-square max-w-md">
            <div className="absolute inset-0 rounded-full bg-primary/5" />
            <div className="absolute inset-6 rounded-full bg-primary/10" />
            <div className="absolute inset-12 flex items-center justify-center rounded-full bg-gradient-to-br from-primary/20 to-primary/5">
              <span className="text-7xl" aria-hidden>
                🍜
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
