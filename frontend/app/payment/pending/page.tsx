import { Suspense } from 'react'
import { Loader2 } from 'lucide-react'
import { PaymentRedirectResult } from '@/components/storefront/payment-redirect-result'

/**
 * Midtrans "Unfinish Redirect URL" landing — the customer left the hosted payment
 * page without completing. Informational only; the webhook owns payment state.
 */
export default function PaymentPendingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <PaymentRedirectResult variant="pending" />
    </Suspense>
  )
}
