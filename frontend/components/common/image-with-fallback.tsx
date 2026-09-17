'use client'

import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { ImageOff } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'> & {
  src: string
  alt: string
  /** Classes for the neutral placeholder shown when the image fails to load. */
  fallbackClassName?: string
}

/**
 * Shared image with a neutral placeholder (P2). Renders a plain <img>; if the image
 * fails to load it is replaced by an internal placeholder carrying the same alt text
 * as its accessible name - no external or catalogue asset is used as the fallback.
 * A new `src` gets a fresh attempt.
 */
export function ImageWithFallback({ src, alt, className, fallbackClassName, ...rest }: Props) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])

  if (failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        data-slot="image-fallback"
        className={cn('flex items-center justify-center bg-muted text-muted-foreground', className, fallbackClassName)}
      >
        <ImageOff className="size-8" aria-hidden="true" />
      </div>
    )
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} {...rest} />
}
