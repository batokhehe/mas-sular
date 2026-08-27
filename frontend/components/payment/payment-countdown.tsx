'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { formatCountdown, isExpired, remainingMs } from '@/lib/payments/countdown'

/**
 * Local 1-second countdown to `expiryAt`. Deliberately does NOT poll the backend:
 * the deadline is known up front, so ticking is a pure client concern. The
 * interval is cleared on unmount and stops itself once the window elapses.
 */
export function PaymentCountdown({ expiryAt, onExpire }: { expiryAt: string | null; onExpire?: () => void }) {
  const [remaining, setRemaining] = useState(() => remainingMs(expiryAt))
  const expired = isExpired(expiryAt) || (Boolean(expiryAt) && remaining === 0)

  useEffect(() => {
    if (!expiryAt) return
    setRemaining(remainingMs(expiryAt))

    const id = window.setInterval(() => {
      const left = remainingMs(expiryAt)
      setRemaining(left)
      if (left === 0) {
        window.clearInterval(id)
        onExpire?.()
      }
    }, 1000)

    return () => window.clearInterval(id)
  }, [expiryAt, onExpire])

  if (!expiryAt) return null

  if (expired) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm font-medium text-destructive">
        <Clock className="size-4" />
        Payment Expired
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border bg-muted/40 p-3">
      <Clock className="size-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Selesaikan dalam</span>
      <span className="font-mono text-base font-semibold tabular-nums">{formatCountdown(remaining)}</span>
    </div>
  )
}
