/**
 * Pure countdown maths for payment expiry. The UI ticks locally once per second
 * from `expiryAt` — it NEVER polls the backend for remaining time.
 */

/** Milliseconds left until expiry; 0 once elapsed (never negative). */
export function remainingMs(expiryAt: string | null | undefined, now: number = Date.now()): number {
  if (!expiryAt) return 0
  const target = new Date(expiryAt).getTime()
  if (Number.isNaN(target)) return 0
  return Math.max(0, target - now)
}

/** Format milliseconds as HH:mm:ss (hours are not capped at 24). */
export function formatCountdown(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * True when the window has elapsed. An absent OR unparseable expiry is NOT
 * expired: some channels (and manual transfer) have no gateway deadline, and a
 * malformed timestamp must never block a customer from paying.
 */
export function isExpired(expiryAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiryAt) return false
  const target = new Date(expiryAt).getTime()
  if (Number.isNaN(target)) return false
  return target <= now
}
