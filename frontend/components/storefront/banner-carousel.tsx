'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { cmsApi } from '@/lib/api/cms.api'
import type { Banner } from '@/lib/types/models'

// Home marketing banners use the 'home' placement. The backend only filters by
// isActive; we additionally respect the real startsAt/endsAt scheduling window.
const HOME_PLACEMENT = 'home'

function isLive(b: Banner): boolean {
  const now = Date.now()
  if (b.startsAt && new Date(b.startsAt).getTime() > now) return false
  if (b.endsAt && new Date(b.endsAt).getTime() < now) return false
  return true
}

/**
 * Real CMS banner carousel (GET /cms/banners?placement=home). Renders only real
 * banner fields — imageUrl, title/description, and the href CTA. Hidden entirely
 * when there are no live banners, so nothing is hardcoded or faked.
 */
export function BannerCarousel() {
  const { data = [] } = useQuery({
    queryKey: ['cms', 'banners', HOME_PLACEMENT],
    queryFn: () => cmsApi.banners(HOME_PLACEMENT),
  })

  const banners = data.filter(isLive)
  if (banners.length === 0) return null

  return (
    <section className="mx-auto max-w-6xl px-4 pt-8">
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
        {banners.map((b) => {
          const className =
            'relative block aspect-[16/7] min-w-[280px] shrink-0 snap-center overflow-hidden rounded-2xl bg-muted sm:min-w-[480px]'
          const content = (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={b.imageUrl} alt={b.title} className="size-full object-cover" />
              {b.title || b.description ? (
                <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/60 to-transparent p-5 text-white">
                  <h3 className="text-lg font-bold sm:text-xl">{b.title}</h3>
                  {b.description ? <p className="line-clamp-2 text-sm opacity-90">{b.description}</p> : null}
                </div>
              ) : null}
            </>
          )
          return b.href ? (
            <Link key={b.id} href={b.href} className={className}>
              {content}
            </Link>
          ) : (
            <div key={b.id} className={className}>
              {content}
            </div>
          )
        })}
      </div>
    </section>
  )
}
