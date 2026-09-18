'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'
import { usePermissions } from '@/lib/auth/use-permissions'
import { formatIDR } from '@/lib/utils/format'
import { orderStatusLabel, paymentStatusLabel } from '@/lib/invoice/labels'
import { orderStatusVariant } from '@/lib/utils/status'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty } from '@/components/common/empty'
import { ErrorState } from '@/components/common/error-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { OrderStatus } from '@/lib/types/enums'

const FILTERS: (OrderStatus | 'ALL')[] = ['ALL', 'PROCESSING', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED', 'CANCELLED']

export default function AdminOrdersPage() {
  const { can } = usePermissions()
  const [status, setStatus] = useState<OrderStatus | 'ALL'>('ALL')

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.admin.orders({ status }),
    queryFn: () => adminApi.orders(status === 'ALL' ? {} : { status }),
    enabled: can('Order.read'),
  })

  if (!can('Order.read')) {
    return <Empty title="Tidak ada akses" description="Anda tidak memiliki izin untuk melihat pesanan." />
  }

  const orders = data ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Pesanan</h1>
        <Select value={status} onValueChange={(v) => setStatus(v as OrderStatus | 'ALL')}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTERS.map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'ALL' ? 'Semua' : orderStatusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : orders.length === 0 ? (
        <Empty title={status === 'ALL' ? 'Belum ada pesanan' : `Tidak ada pesanan berstatus ${orderStatusLabel(status)}`} />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pesanan</TableHead>
                <TableHead>Pelanggan</TableHead>
                <TableHead>Pembayaran</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Tanggal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id} className="cursor-pointer">
                  <TableCell className="font-medium">
                    <Link href={`/admin/orders/${order.id}`} className="hover:underline">
                      {order.orderNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{order.user?.name ?? '—'}</TableCell>
                  <TableCell>
                    {order.payment ? <Badge variant="outline">{paymentStatusLabel(order.payment.status)}</Badge> : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={orderStatusVariant(order.status)}>{orderStatusLabel(order.status)}</Badge>
                  </TableCell>
                  <TableCell>{formatIDR(order.totalPrice)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(order.createdAt).toLocaleDateString('id-ID')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
