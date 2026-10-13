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
      {/*
        Layout (P2 #2): each card has a FIXED responsive width (~85% on mobile so the
        next card peeks, 2 per view from sm, 3 per view from lg) so text wraps inside
        it instead of widening the card. Height comes from the content, not a 16:9
        ratio, and the row's default stretch gives every card the same height; the
        title and description are capped at two lines each so one long promo cannot
        inflate the whole row. The full text stays available via `title`.
      */}
      <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {promos.map((promo) => (
          <div
            key={promo.id}
            className="relative w-[85%] shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-primary via-primary/90 to-primary/80 p-4 text-primary-foreground sm:w-[calc((100%-1rem)/2)] sm:p-5 lg:w-[calc((100%-2rem)/3)]"
          >
            <div className="relative flex h-full flex-col justify-between gap-2">
              <div>
                <p className="mb-1 text-xs font-medium opacity-90 [overflow-wrap:anywhere]">Kode: {promo.code}</p>
                <h3
                  title={promo.title}
                  className="line-clamp-2 text-lg font-bold leading-tight [overflow-wrap:anywhere] sm:text-xl"
                >
                  {promo.title}
                </h3>
              </div>
              <p title={promo.description} className="line-clamp-2 text-sm opacity-90 [overflow-wrap:anywhere]">
                {promo.description}
              </p>
            </div>
            <div className="absolute -bottom-8 -right-8 size-32 rounded-full bg-white/10" />
            <div className="absolute -right-4 -top-4 size-16 rounded-full bg-white/10" />
          </div>
        ))}
      </div>
    </section>
  )
}
