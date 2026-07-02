'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'
import { usePermissions } from '@/lib/auth/use-permissions'
import { formatIDR } from '@/lib/utils/format'
import {
  NEXT_ORDER_STATUS,
  CANCELLABLE_ORDER_STATUS,
  SHIPMENT_STATUSES,
  orderStatusVariant,
  paymentStatusVariant,
  shipmentStatusVariant,
} from '@/lib/utils/status'
import { confirmStatusChange, confirmCreate, confirmUpdate, showLoading, showSuccess, showError } from '@/lib/utils/admin-alert'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/common/error-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { OrderStatus, ShipmentStatus } from '@/lib/types/enums'
import type { Shipment } from '@/lib/types/models'

export default function AdminOrderDetailPage() {
  const params = useParams<{ id: string }>()
  const id = params?.id as string
  const { can } = usePermissions()
  const qc = useQueryClient()

  const { data: order, isLoading, isError, refetch } = useQuery({
    queryKey: qk.admin.order(id),
    queryFn: () => adminApi.order(id),
    enabled: !!id && can('Order.read'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.admin.order(id) })
    qc.invalidateQueries({ queryKey: ['admin', 'orders'] })
  }

  const setStatus = useMutation({
    mutationFn: (status: OrderStatus) => adminApi.updateOrderStatus(id, { status }),
    meta: { suppressGlobalError: true },
    onSuccess: invalidate,
  })

  if (!can('Order.read')) return <ErrorState title="No access" description="You cannot view orders." />
  if (isLoading) return <DetailSkeleton />
  if (isError || !order) return <ErrorState description="Order not found." onRetry={() => void refetch()} />

  const nextStatuses = NEXT_ORDER_STATUS[order.status] ?? []
  const canCancel = CANCELLABLE_ORDER_STATUS.has(order.status)

  async function changeStatus(next: OrderStatus, opts?: { title?: string }) {
    if (!order) return
    if (!(await confirmStatusChange(order.status, next, { title: opts?.title }))) return
    showLoading()
    try {
      await setStatus.mutateAsync(next)
      await showSuccess('Success', 'Order updated successfully')
    } catch (error) {
      await showError(error)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header + progression */}
      <Card className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">{order.orderNumber}</h1>
            <p className="text-sm text-muted-foreground">
              {new Date(order.createdAt).toLocaleString('id-ID')} · {formatIDR(order.totalPrice)}
            </p>
          </div>
          <Badge variant={orderStatusVariant(order.status)}>{order.status}</Badge>
        </div>

        {can('Order.update') ? (
          <div className="flex flex-wrap gap-2">
            {nextStatuses.map((next) => (
              <Button key={next} size="sm" disabled={setStatus.isPending} onClick={() => changeStatus(next)}>
                {setStatus.isPending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
                Mark as {next}
              </Button>
            ))}
            {canCancel ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={setStatus.isPending}
                onClick={() => changeStatus('CANCELLED', { title: 'Cancel Order?' })}
              >
                Cancel order
              </Button>
            ) : null}
            {nextStatuses.length === 0 && !canCancel ? (
              <p className="text-sm text-muted-foreground">No further transitions.</p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Customer + address */}
        <Card className="space-y-2 p-5">
          <h2 className="font-semibold">Customer</h2>
          <p className="text-sm">{order.user?.name ?? '—'}</p>
          <p className="text-sm text-muted-foreground">{order.user?.email}</p>
          <p className="text-sm text-muted-foreground">{order.user?.phone ?? '—'}</p>
          <Separator className="my-2" />
          <h3 className="text-sm font-semibold">Delivery address</h3>
          {order.address ? (
            <p className="text-sm text-muted-foreground">
              {order.address.recipientName} · {order.address.phone}
              <br />
              {order.address.fullAddress}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
        </Card>

        {/* Payment */}
        <Card className="space-y-2 p-5">
          <h2 className="font-semibold">Payment</h2>
          {order.payment ? (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={paymentStatusVariant(order.payment.status)}>{order.payment.status}</Badge>
                <span className="text-sm text-muted-foreground">{order.payment.method}</span>
              </div>
              <p className="text-sm">{formatIDR(order.payment.amount)}</p>
              {order.payment.manualReceiptUrl ? (
                <a
                  href={order.payment.manualReceiptUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary underline"
                >
                  View receipt
                </a>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No payment record.</p>
          )}
        </Card>
      </div>

      {/* Items */}
      <Card className="p-5">
        <h2 className="mb-3 font-semibold">Items</h2>
        <ul className="divide-y">
          {(order.items ?? []).map((item) => (
            <li key={item.id} className="flex items-center justify-between py-2 text-sm">
              <span>
                {item.quantity}× {item.productName}
              </span>
              <span>{formatIDR(item.unitPrice * item.quantity)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Shipment */}
      <ShipmentSection orderId={id} shipment={order.shipment ?? null} canManage={can('Shipment.create') || can('Shipment.update')} onChange={invalidate} />
    </div>
  )
}

function ShipmentSection({
  orderId,
  shipment,
  canManage,
  onChange,
}: {
  orderId: string
  shipment: Shipment | null
  canManage: boolean
  onChange: () => void
}) {
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminApi.createShipment(body),
    meta: { suppressGlobalError: true },
    onSuccess: onChange,
  })
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => adminApi.updateShipment(shipment!.id, body),
    meta: { suppressGlobalError: true },
    onSuccess: onChange,
  })

  const [provider, setProvider] = useState('')
  const [service, setService] = useState('')
  const [cost, setCost] = useState('')
  const [tracking, setTracking] = useState(shipment?.trackingNumber ?? '')

  async function handleCreate() {
    if (!(await confirmCreate())) return
    showLoading()
    try {
      await create.mutateAsync({
        orderId,
        provider,
        service,
        cost: Number(cost) || 0,
        trackingNumber: tracking || undefined,
      })
      await showSuccess('Success', 'Shipment created successfully')
    } catch (error) {
      await showError(error)
    }
  }

  async function handleSaveTracking() {
    if (!(await confirmUpdate())) return
    showLoading()
    try {
      await update.mutateAsync({ trackingNumber: tracking || undefined })
      await showSuccess('Success', 'Shipment updated successfully')
    } catch (error) {
      await showError(error)
    }
  }

  async function handleStatusChange(next: ShipmentStatus) {
    if (!shipment || next === shipment.status) return
    if (!(await confirmStatusChange(shipment.status, next, { title: 'Update Shipment Status?' }))) return
    showLoading()
    try {
      await update.mutateAsync({ status: next })
      await showSuccess('Success', 'Shipment updated successfully')
    } catch (error) {
      await showError(error)
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <h2 className="font-semibold">Shipment</h2>

      {shipment ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={shipmentStatusVariant(shipment.status)}>{shipment.status}</Badge>
            <span>
              {shipment.provider} · {shipment.service} · {formatIDR(shipment.cost)}
            </span>
          </div>

          {canManage ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="tracking">Tracking number</Label>
                <Input id="tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} />
              </div>
              <Button variant="outline" disabled={update.isPending} onClick={handleSaveTracking}>
                Save tracking
              </Button>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={shipment.status} onValueChange={(v) => handleStatusChange(v as ShipmentStatus)}>
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHIPMENT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
        </div>
      ) : canManage ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="provider">Courier</Label>
            <Input id="provider" placeholder="JNE, Paxel…" value={provider} onChange={(e) => setProvider(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service">Service</Label>
            <Input id="service" placeholder="REG, Same Day…" value={service} onChange={(e) => setService(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost">Cost</Label>
            <Input id="cost" type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ctracking">Tracking number</Label>
            <Input id="ctracking" value={tracking} onChange={(e) => setTracking(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Button disabled={create.isPending || !provider || !service} onClick={handleCreate}>
              {create.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Create shipment
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No shipment yet.</p>
      )}
    </Card>
  )
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
      <Skeleton className="h-32 w-full rounded-lg" />
    </div>
  )
}
