'use client'

import { useQuery } from '@tanstack/react-query'
import { productsApi } from '@/lib/api/products.api'

/**
 * Promo banner section — real vouchers from GET /catalog/promos (active + valid,
 * server-filtered). Renders only the real Promo fields (code / title / description).
 * Hidden entirely when there are no active promos — no placeholder/fabricated cards.
 */
export function PromoCarousel() {
  const { data: promos = [] } = useQuery({
    queryKey: ['catalog', 'promos'],
    queryFn: productsApi.promos,
  })

  if (promos.length === 0) return null

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8">
      <h2 className="mb-4 text-xl font-bold">Promo Spesial</h2>
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {promos.map((promo) => (
          <div
            key={promo.id}
            className="relative aspect-[16/9] min-w-[280px] shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-primary/80 p-5 text-primary-foreground sm:min-w-[320px]"
          >
            <div className="relative flex h-full flex-col justify-between">
              <div>
                <p className="mb-1 text-xs font-medium opacity-90">Kode: {promo.code}</p>
                <h3 className="text-lg font-bold leading-tight sm:text-xl">{promo.title}</h3>
              </div>
              <p className="line-clamp-2 text-sm opacity-90">{promo.description}</p>
            </div>
            <div className="absolute -bottom-8 -right-8 size-32 rounded-full bg-white/10" />
            <div className="absolute -right-4 -top-4 size-16 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
    </section>
  )
}
