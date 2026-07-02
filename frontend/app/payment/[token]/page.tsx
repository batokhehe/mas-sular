'use client'

import { useParams, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { paymentsApi } from '@/lib/api/payments.api'
import { qk } from '@/lib/query/keys'
import { UploadReceipt } from '@/components/storefront/upload-receipt'
import { ErrorState } from '@/components/common/error-state'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatIDR } from '@/lib/utils/format'

export default function PaymentUploadPage() {
  const params = useParams<{ token: string }>()
  const router = useRouter()
  const token = params?.token

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.uploadPage(token ?? ''),
    queryFn: () => paymentsApi.uploadPage(token as string),
    enabled: !!token,
    retry: false,
  })

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <h1 className="mb-1 text-center text-xl font-bold">Upload payment receipt</h1>
      <p className="mb-6 text-center text-sm text-muted-foreground">
        Submit your transfer proof to verify your payment.
      </p>

      {isLoading ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-40 w-full" />
        </Card>
      ) : isError || !data ? (
        <ErrorState
          title="Link unavailable"
          description="This upload link is invalid, already used, or expired."
          onRetry={() => void refetch()}
        />
      ) : (
        <Card className="space-y-4 p-5">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Order</span>
              <span className="font-semibold">{data.orderNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-semibold">{formatIDR(data.amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Method</span>
              <span className="font-semibold">{data.method}</span>
            </div>
            {data.bankName ? (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bank</span>
                <span className="font-semibold">{data.bankName}</span>
              </div>
            ) : null}
          </div>
          <UploadReceipt
            mode="token"
            reference={token as string}
            onUploaded={() =>
              router.replace(`/payment/success?order=${encodeURIComponent(data.orderNumber)}`)
            }
          />
        </Card>
      )}
    </div>
  )
}
