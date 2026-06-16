'use client'

import { useState } from 'react'
import Link from 'next/link'
import { StorefrontShell } from '@/components/storefront/shell'
import { UploadReceipt } from '@/components/storefront/upload-receipt'
import { Empty } from '@/components/common/empty'
import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { formatIDR } from '@/lib/utils/format'
import { useMe } from '@/lib/query/hooks/use-me'
import { useOrders } from '@/lib/query/hooks/use-orders'
import type { PaymentStatus } from '@/lib/types/enums'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

const PAYMENT_LABEL: Record<string, { label: string; variant: BadgeVariant }> = {
  PENDING: { label: 'Awaiting payment', variant: 'outline' },
  WAITING_VERIFICATION: { label: 'Under review', variant: 'secondary' },
  PAID: { label: 'Paid', variant: 'default' },
  FAILED: { label: 'Rejected', variant: 'destructive' },
  EXPIRED: { label: 'Expired', variant: 'destructive' },
  REFUNDED: { label: 'Refunded', variant: 'secondary' },
}

const UPLOADABLE: PaymentStatus[] = ['PENDING', 'WAITING_VERIFICATION']
const RECEIPT_METHODS = new Set(['BANK_TRANSFER', 'QRIS'])

export default function OrdersPage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: orders, isLoading, isError, refetch } = useOrders()
  const [openUpload, setOpenUpload] = useState<string | null>(null)

  if (!meLoading && !me) {
    return (
      <StorefrontShell>
        <Empty
          title="Please sign in"
          description="Sign in to view your orders."
          action={
            <Button asChild className="mt-2">
              <Link href="/login">Sign in</Link>
            </Button>
          }
        />
      </StorefrontShell>
    )
  }

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Order History</h1>

        {isLoading || meLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState onRetry={() => void refetch()} />
        ) : !orders || orders.length === 0 ? (
          <Empty
            title="No orders yet"
            action={
              <Button asChild className="mt-2">
                <Link href="/catalog">Start shopping</Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            {orders.map((order) => {
              const payment = order.payment
              const pay = payment ? PAYMENT_LABEL[payment.status] : undefined
              const canUpload =
                payment &&
                RECEIPT_METHODS.has(order.paymentMethod) &&
                UPLOADABLE.includes(payment.status)
              return (
                <Card key={order.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold">{order.orderNumber}</p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString('id-ID')} · {formatIDR(order.totalPrice)}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="outline">{order.status}</Badge>
                      {pay ? <Badge variant={pay.variant}>{pay.label}</Badge> : null}
                      {order.shipment ? (
                        <Badge variant="secondary">Shipping: {order.shipment.status}</Badge>
                      ) : null}
                    </div>
                  </div>

                  {canUpload ? (
                    <>
                      <Separator />
                      {openUpload === order.id ? (
                        <UploadReceipt
                          mode="auth"
                          reference={payment!.id}
                          onUploaded={() => void refetch()}
                        />
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => setOpenUpload(order.id)}>
                          Upload payment receipt
                        </Button>
                      )}
                    </>
                  ) : null}
                </Card>
              )
            })}
          </div>
        )}
      </section>
    </StorefrontShell>
  )
}
