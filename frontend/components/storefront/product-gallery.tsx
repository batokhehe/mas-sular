'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from '@/components/ui/carousel'
import { ImageWithFallback } from '@/components/common/image-with-fallback'
import { cn } from '@/lib/utils'
import {
  galleryImages,
  hasCarouselControls,
  imageLoading,
  slideLabel,
  thumbnailLabel,
  thumbnailTarget,
} from '@/lib/products/product-gallery'
import type { Product } from '@/lib/types/models'

const FRAME = 'relative overflow-hidden rounded-2xl border bg-muted'
const IMAGE = 'aspect-square w-full object-cover'

/**
 * P2 product image gallery on the shared Embla carousel (components/ui/carousel).
 *
 * 0 images -> Product.imageUrl; 1 image -> a single image, no controls; 2+ -> swipe,
 * previous/next, keyboard arrows (the region is focusable) and thumbnails. Every
 * image uses the product name as alt text; only the cover loads eagerly. `overlay`
 * (the product badges) sits over the main image exactly as before.
 *
 * The primitive places its buttons OUTSIDE the slide area, where this frame's
 * overflow-hidden would clip them, so they are positioned inside via className only.
 */
export function ProductGallery({ product, overlay }: { product: Pick<Product, 'name' | 'imageUrl' | 'images'>; overlay?: ReactNode }) {
  const images = galleryImages(product)
  const [api, setApi] = useState<CarouselApi>()
  const [selected, setSelected] = useState(0)

  const onSelect = useCallback((carousel: NonNullable<CarouselApi>) => setSelected(carousel.selectedScrollSnap()), [])
  useEffect(() => {
    if (!api) return
    onSelect(api)
    api.on('select', onSelect)
    api.on('reInit', onSelect)
    return () => {
      api.off('select', onSelect)
      api.off('reInit', onSelect)
    }
  }, [api, onSelect])

  if (!hasCarouselControls(images.length)) {
    const [only] = images
    return (
      <div className={FRAME}>
        {only ? <ImageWithFallback src={only.url} alt={product.name} loading="eager" className={IMAGE} /> : <div className={cn(IMAGE, 'bg-muted')} role="img" aria-label={product.name} />}
        {overlay}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className={FRAME}>
        <Carousel setApi={setApi} opts={{ loop: false }} tabIndex={0} aria-label={`Galeri foto ${product.name}`} className="outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <CarouselContent className="ml-0">
            {images.map((image, index) => (
              <CarouselItem key={image.key} className="pl-0" aria-label={slideLabel(index, images.length)}>
                <ImageWithFallback src={image.url} alt={product.name} loading={imageLoading(index)} className={IMAGE} />
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious className="left-3 bg-background/80" aria-label="Gambar sebelumnya" />
          <CarouselNext className="right-3 bg-background/80" aria-label="Gambar berikutnya" />
        </Carousel>
        {overlay}
      </div>

      <ul className="flex gap-2 overflow-x-auto pb-1" aria-label={`Thumbnail foto ${product.name}`}>
        {images.map((image, index) => (
          <li key={image.key} className="shrink-0">
            <button
              type="button"
              onClick={() => api?.scrollTo(thumbnailTarget(index, images.length))}
              aria-label={thumbnailLabel(product.name, index, images.length)}
              aria-current={index === selected ? 'true' : undefined}
              className={cn(
                'block size-16 overflow-hidden rounded-lg border-2 transition-colors sm:size-20',
                index === selected ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100',
              )}
            >
              <ImageWithFallback src={image.url} alt="" loading="lazy" className="size-full object-cover" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
