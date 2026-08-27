import { cn } from '@/lib/utils'
import { providerLogoSrc } from './provider-logo-assets'

/**
 * Local logo artwork keyed by the backend's stable provider id.
 */

/** Short, stable monogram for a provider with no artwork (e.g. 'Paxel' -> 'PA'). */
function monogram(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return '?'
  return (trimmed.length <= 3 ? trimmed : trimmed.slice(0, 2)).toUpperCase()
}

/**
 * Provider mark for a checkout shipping group. Both branches occupy the same
 * fixed 72x36 box, so wide supplied marks stay readable without stretching or
 * shifting the provider heading on narrow screens.
 */
export function ProviderLogo({
  provider,
  title,
  className,
}: {
  provider: string
  title: string
  className?: string
}) {
  const src = providerLogoSrc(provider)

  if (src) {
    return (
      <span className={cn('flex h-9 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted', className)}>
        {/* Decorative: the adjacent group heading provides the accessible name. */}
        <img src={src} alt="" aria-hidden="true" width={72} height={36} className="size-full object-contain" />
      </span>
    )
  }

  return (
    <span
      // Decorative: the group heading next to it already names the provider,
      // so announcing the monogram too would just repeat it.
      aria-hidden="true"
      className={cn(
        'flex h-9 w-[4.5rem] shrink-0 items-center justify-center rounded-lg border bg-muted',
        'text-[11px] font-semibold uppercase tracking-tight text-muted-foreground',
        className,
      )}
    >
      {monogram(title)}
    </span>
  )
}
