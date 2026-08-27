'use client'

import { useState } from 'react'
import Link from 'next/link'
import {
  Clock,
  Package,
  Truck,
  CheckCircle2,
  XCircle,
  ChevronDown,
  MapPin,
} from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useMe } from '@/lib/query/hooks/use-me'
import { useOrders } from '@/lib/query/hooks/use-orders'
import { canResumeGatewayPayment, gatewayPaymentHref } from '@/lib/payments/resume'
import type { Order } from '@/lib/types/models'
import type { OrderStatus, PaymentStatus, ShipmentStatus } from '@/lib/types/enums'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

// Payment status mapping — preserved exactly from the previous implementation.
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

// Presentation only — derived from the real OrderStatus / ShipmentStatus values.
const ORDER_META: Record<OrderStatus, { label: string; variant: BadgeVariant; icon: typeof Clock }> = {
  PENDING: { label: 'Pending', variant: 'outline', icon: Clock },
  PROCESSING: { label: 'Processing', variant: 'secondary', icon: Package },
  PACKING: { label: 'Packing', variant: 'secondary', icon: Package },
  SHIPPED: { label: 'Shipped', variant: 'secondary', icon: Truck },
  DELIVERING: { label: 'Delivering', variant: 'secondary', icon: Truck },
  DELIVERED: { label: 'Delivered', variant: 'default', icon: CheckCircle2 },
  COMPLETED: { label: 'Completed', variant: 'default', icon: CheckCircle2 },
  CANCELLED: { label: 'Cancelled', variant: 'destructive', icon: XCircle },
}

const SHIPMENT_LABEL: Record<ShipmentStatus, { label: string; variant: BadgeVariant }> = {
  PENDING: { label: 'Pending', variant: 'outline' },
  RATE_SELECTED: { label: 'Rate selected', variant: 'outline' },
  PICKED_UP: { label: 'Picked up', variant: 'secondary' },
  IN_TRANSIT: { label: 'In transit', variant: 'secondary' },
  DELIVERED: { label: 'Delivered', variant: 'default' },
  FAILED: { label: 'Failed', variant: 'destructive' },
}

function OrderCard({ order, onRefetch }: { order: Order; onRefetch: () => void }) {
  const [showDetails, setShowDetails] = useState(false)
  const [showUpload, setShowUpload] = useState(false)

  const items = order.items ?? []
  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0)
  const meta = ORDER_META[order.status]
  const StatusIcon = meta.icon
  const payment = order.payment
  const pay = payment ? PAYMENT_LABEL[payment.status] : undefined
  const canUpload =
    payment && RECEIPT_METHODS.has(order.paymentMethod) && UPLOADABLE.includes(payment.status)
  // A gateway payment the customer never finished. The link replays the attempt
  // already stored at checkout — it starts no new charge.
  const canResume = canResumeGatewayPayment(payment)

  return (
    <Card className="space-y-3 p-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold">{order.orderNumber}</p>
          <p className="text-sm text-muted-foreground">
            {new Date(order.createdAt).toLocaleDateString('id-ID')} · {formatIDR(order.totalPrice)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Badge variant={meta.variant} className="gap-1">
            <StatusIcon className="size-3" />
            {meta.label}
          </Badge>
          {pay ? <Badge variant={pay.variant}>{pay.label}</Badge> : null}
          {order.shipment ? (
            <Badge variant={SHIPMENT_LABEL[order.shipment.status].variant}>
              Shipping: {SHIPMENT_LABEL[order.shipment.status].label}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Items summary (real item names + count) */}
      {items.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          {itemCount} item · {items.map((i) => i.productName).join(', ')}
        </p>
      ) : null}

      <button
        onClick={() => setShowDetails((v) => !v)}
        className="flex items-center gap-1 text-sm font-medium text-primary"
      >
        {showDetails ? 'Hide details' : 'View details'}
        <ChevronDown className={cn('size-4 transition-transform', showDetails && 'rotate-180')} />
      </button>

      {showDetails ? (
        <div className="space-y-4 rounded-lg bg-muted/40 p-3 text-sm">
          {/* Items */}
          <div className="space-y-2">
            <h4 className="font-medium">Items</h4>
            {items.map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3">
                <div>
                  <p>
                    {item.quantity}× {item.productName}
                  </p>
                  {item.toppings.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      + {item.toppings.map((t) => t.name).join(', ')}
                    </p>
                  ) : null}
                  {item.notes ? <p className="text-xs italic text-muted-foreground">“{item.notes}”</p> : null}
                </div>
                <span className="shrink-0 font-medium">{formatIDR(item.unitPrice * item.quantity)}</span>
              </div>
            ))}
          </div>

          {/* Payment breakdown — REAL server-computed Order fields only */}
          <Separator />
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatIDR(order.subtotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivery fee</span>
              <span>{formatIDR(order.deliveryFee)}</span>
            </div>
            {order.voucherDiscountAmount > 0 ? (
              <div className="flex justify-between text-green-600">
                <span>Voucher discount{order.voucherCode ? ` (${order.voucherCode})` : ''}</span>
                <span>-{formatIDR(order.voucherDiscountAmount)}</span>
              </div>
            ) : null}
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>Total</span>
              <span className="text-primary">{formatIDR(order.totalPrice)}</span>
            </div>
          </div>

          {/* Shipment — real fields only (no fabricated tracking events) */}
          {order.shipment ? (
            <>
              <Separator />
              <div className="space-y-1">
                <h4 className="font-medium">Shipment</h4>
                <p className="text-muted-foreground">
                  {order.shipment.provider} · {order.shipment.service} ·{' '}
                  {SHIPMENT_LABEL[order.shipment.status].label}
                </p>
                {order.shipment.trackingNumber ? (
                  <p className="text-muted-foreground">
                    Tracking:{' '}
                    {order.shipment.trackingUrl ? (
                      <a
                        href={order.shipment.trackingUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline"
                      >
                        {order.shipment.trackingNumber}
                      </a>
                    ) : (
                      order.shipment.trackingNumber
                    )}
                  </p>
                ) : null}
                {order.estimatedDelivery ? (
                  <p className="text-muted-foreground">
                    Estimated delivery: {new Date(order.estimatedDelivery).toLocaleDateString('id-ID')}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {/* Address — real fields */}
          {order.address ? (
            <>
              <Separator />
              <div className="space-y-1">
                <h4 className="flex items-center gap-1 font-medium">
                  <MapPin className="size-3.5" /> Delivery address
                </h4>
                <p className="text-muted-foreground">
                  {order.address.recipientName} · {order.address.phone}
                  <br />
                  {order.address.fullAddress}
                </p>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Resume an unfinished gateway payment. Navigation only: the payment page
          re-reads the stored attempt, so no QR data travels through the URL. */}
      {canResume ? (
        <>
          <Separator />
          <Button asChild size="sm" className="rounded-full">
            <Link href={gatewayPaymentHref(payment!.id)}>Bayar Sekarang</Link>
          </Button>
        </>
      ) : null}

      {/* Payment receipt upload — preserved exactly */}
      {canUpload ? (
        <>
          <Separator />
          {showUpload ? (
            <UploadReceipt
              mode="auth"
              reference={payment!.id}
              onUploaded={() => {
                setShowUpload(false)
                onRefetch()
              }}
            />
          ) : (
            <Button size="sm" variant="outline" onClick={() => setShowUpload(true)}>
              Upload payment receipt
            </Button>
          )}
        </>
      ) : null}
    </Card>
  )
}

export default function OrdersPage() {
  const { data: me, isLoading: meLoading } = useMe()
  const { data: orders, isLoading, isError, refetch } = useOrders()

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
            {orders.map((order) => (
              <OrderCard key={order.id} order={order} onRefetch={() => void refetch()} />
            ))}
          </div>
        )}
      </section>
    </StorefrontShell>
  )
}
