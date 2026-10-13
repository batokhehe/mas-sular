'use client'

import { useParams, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { paymentsApi } from '@/lib/api/payments.api'
import { qk } from '@/lib/query/keys'
import { UploadReceipt } from '@/components/storefront/upload-receipt'
import { PaymentBreakdown } from '@/components/storefront/payment-breakdown'
import { ErrorState } from '@/components/common/error-state'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { paymentBreakdownFromUpload } from '@/lib/checkout/summary'
import { paymentMethodLabel } from '@/lib/invoice/labels'

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
      <h1 className="mb-1 text-center text-xl font-bold">Unggah bukti pembayaran</h1>
      <p className="mb-6 text-center text-sm text-muted-foreground">
        Kirim bukti transfer untuk verifikasi pembayaran Anda.
      </p>

      {isLoading ? (
        <Card className="space-y-3 p-5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-40 w-full" />
        </Card>
      ) : isError || !data ? (
        <ErrorState
          title="Tautan tidak tersedia"
          description="Tautan unggah ini tidak valid, sudah digunakan, atau kedaluwarsa."
          onRetry={() => void refetch()}
        />
      ) : (
        <Card className="space-y-4 p-5">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pesanan</span>
              <span className="font-semibold">{data.orderNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Metode</span>
              <span className="font-semibold">{paymentMethodLabel(data.method)}</span>
            </div>
            {data.bankName ? (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bank</span>
                <span className="font-semibold">{data.bankName}</span>
              </div>
            ) : null}
          </div>

          {/* Business Total / Unique Payment Code / Transfer Exactly — backend values only. */}
          <PaymentBreakdown {...paymentBreakdownFromUpload(data)} />

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
