'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CheckCircle2, Headset, Home, Loader2, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { hasCustomerSession } from '@/lib/auth/tokens'
import { PaymentRedirectResult } from '@/components/storefront/payment-redirect-result'
import { isMidtransRedirect } from '@/lib/payments/redirect-params'

// Support channel (configurable); safe default. Never a token/ID.
const SUPPORT_URL = process.env.NEXT_PUBLIC_SUPPORT_URL || 'mailto:cs@baksomassular.com'

function SuccessInner() {
  const router = useRouter()
  const params = useSearchParams()

  // Midtrans's Finish Redirect URL points at this same route, so the two landings
  // share it. A Midtrans redirect carries `order_id` / `transaction_status` /
  // `status_code`; the manual receipt-upload flow navigates here with `?order=`.
  // Discriminating on those params keeps the existing BANK_TRANSFER copy intact.
  if (isMidtransRedirect(params)) {
    return <PaymentRedirectResult variant="success" />
  }

  // Order number is a human-facing identifier (shown on orders + WhatsApp) — NOT the
  // upload token. Passed via query on redirect; absent on a direct visit.
  const orderNumber = params.get('order')

  const [showOrders, setShowOrders] = useState(false)
  useEffect(() => setShowOrders(hasCustomerSession()), [])

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <Card className="flex flex-col items-center gap-4 p-8 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-green-100">
          <CheckCircle2 className="size-10 text-green-600" />
        </div>

        <h1 className="text-xl font-bold">Payment receipt uploaded successfully</h1>

        {orderNumber ? (
          <div className="rounded-full bg-muted px-3 py-1 text-sm">
            <span className="text-muted-foreground">Order</span>{' '}
            <span className="font-semibold">{orderNumber}</span>
          </div>
        ) : null}

        <p className="text-sm text-muted-foreground">
          Thank you. Your payment receipt has been received and will be verified by our team.
        </p>
        <p className="text-sm text-muted-foreground">
          Verification usually takes <span className="font-medium text-foreground">5–15 minutes</span> during
          business hours. You will receive another WhatsApp notification once your payment has been verified.
        </p>

        <div className="mt-2 flex w-full flex-col gap-2">
          {showOrders ? (
            <Button className="w-full" onClick={() => router.push('/orders')}>
              <Package className="mr-2 size-4" /> View My Orders
            </Button>
          ) : null}
          <Button
            className="w-full"
            variant={showOrders ? 'outline' : 'default'}
            onClick={() => router.push('/')}
          >
            <Home className="mr-2 size-4" /> Back to Home
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
              <Headset className="mr-2 size-4" /> Contact Customer Service
            </a>
          </Button>
        </div>
      </Card>
    </div>
  )
}

export default function PaymentUploadSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <SuccessInner />
    </Suspense>
  )
}
