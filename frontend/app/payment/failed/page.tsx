import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { PaymentRedirectResult } from '@/components/storefront/payment-redirect-result'

/**
 * Midtrans "Error Redirect URL" landing. Shows a friendly explanation only — the
 * raw provider error is never surfaced, and no retry is offered because the backend
 * exposes no payment-retry endpoint (inventing one is out of scope).
 */
export default function PaymentFailedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PaymentRedirectResult variant="failed" />
    </Suspense>
  )
}
