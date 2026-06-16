'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, CreditCard, Clock, TimerOff, AlarmClock, Package, Truck, PackageCheck } from 'lucide-react'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'
import { useAdminPayments } from '@/lib/query/hooks/use-admin-payments'
import { usePermissions } from '@/lib/auth/use-permissions'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Empty } from '@/components/common/empty'
import { formatIDR } from '@/lib/utils/format'

function StatCard({
  label,
  value,
  icon,
  loading,
}: {
  label: string
  value: number
  icon: ReactNode
  loading: boolean
}) {
  return (
    <Card className="flex items-center gap-4 p-5">
      <div className="rounded-lg bg-primary/10 p-3 text-primary">{icon}</div>
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        {loading ? <Skeleton className="mt-1 h-7 w-12" /> : <p className="text-2xl font-bold">{value}</p>}
      </div>
    </Card>
  )
}

export default function AdminDashboardPage() {
  const { can } = usePermissions()
  const canPayments = can('Payment.read')
  const canOrders = can('Order.read')

  const verification = useAdminPayments() // WAITING_VERIFICATION
  const pending = useAdminPayments('PENDING')
  const expired = useAdminPayments('EXPIRED')
  const ordersQuery = useQuery({
    queryKey: qk.admin.orders({}),
    queryFn: () => adminApi.orders({}),
    enabled: canOrders,
  })

  const allOrders = ordersQuery.data ?? []
  const recentOrders = allOrders.slice(0, 5)
  const orderCount = (s: string) => allOrders.filter((o) => o.status === s).length

  // "Expiring soon": still-open payments created past the 2nd reminder (>20h),
  // i.e. within ~4h of the 24h expiry window.
  const TWENTY_HOURS = 20 * 60 * 60 * 1000
  const expiringSoon = [...(verification.data ?? []), ...(pending.data ?? [])].filter(
    (p) => Date.now() - new Date(p.createdAt).getTime() > TWENTY_HOURS,
  ).length

  if (!canPayments && !canOrders) {
    return <Empty title="No dashboard access" description="Your account has no dashboard permissions." />
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {canPayments ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Awaiting verification"
            value={verification.data?.length ?? 0}
            loading={verification.isLoading}
            icon={<Clock className="size-5" />}
          />
          <StatCard
            label="Pending payment"
            value={pending.data?.length ?? 0}
            loading={pending.isLoading}
            icon={<CreditCard className="size-5" />}
          />
          <StatCard
            label="Expiring soon"
            value={expiringSoon}
            loading={verification.isLoading || pending.isLoading}
            icon={<AlarmClock className="size-5" />}
          />
          <StatCard
            label="Expired"
            value={expired.data?.length ?? 0}
            loading={expired.isLoading}
            icon={<TimerOff className="size-5" />}
          />
        </div>
      ) : null}

      {canOrders ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Processing" value={orderCount('PROCESSING')} loading={ordersQuery.isLoading} icon={<Package className="size-5" />} />
          <StatCard label="Shipped" value={orderCount('SHIPPED')} loading={ordersQuery.isLoading} icon={<Truck className="size-5" />} />
          <StatCard label="Delivered" value={orderCount('DELIVERED')} loading={ordersQuery.isLoading} icon={<PackageCheck className="size-5" />} />
        </div>
      ) : null}

      {canOrders ? (
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <ClipboardList className="size-5 text-muted-foreground" />
            <h2 className="font-semibold">Recent orders</h2>
          </div>
          {ordersQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : recentOrders.length === 0 ? (
            <Empty title="No orders yet" />
          ) : (
            <ul className="divide-y">
              {recentOrders.map((order) => (
                <li key={order.id} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <p className="font-medium">{order.orderNumber}</p>
                    <p className="text-muted-foreground">{order.user?.name ?? '—'}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span>{formatIDR(order.totalPrice)}</span>
                    <Badge variant="outline">{order.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canPayments ? (
            <Link href="/admin/payments" className="mt-4 inline-block text-sm text-primary underline">
              Go to payment verification →
            </Link>
          ) : null}
        </Card>
      ) : null}
    </div>
  )
}
