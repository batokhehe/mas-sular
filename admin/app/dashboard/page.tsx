'use client';

import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminDashboard, fetchAdminOrders } from '@/lib/admin';
import { useAdminAuthStatus, useAdminProfile } from '@/lib/auth';
import { ArrowDown, ArrowUp, CreditCard, PackageCheck, ShoppingBag, CheckCircle2, Users as UsersIcon } from 'lucide-react';

export default function DashboardPage() {
  const authStatus = useAdminAuthStatus();
  const profile = useAdminProfile({ enabled: authStatus.isInitialized && authStatus.hasToken });
  const canFetchProtectedApis = profile.isSuccess;
  const dashboard = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn: fetchAdminDashboard,
    retry: false,
    enabled: canFetchProtectedApis,
  });
  const orders = useQuery({
    queryKey: ['admin-orders', 'dashboard'],
    queryFn: fetchAdminOrders,
    retry: false,
    enabled: canFetchProtectedApis,
  });
  const data = dashboard.data;
  const stats = [
    { label: 'Total Products', value: data?.activeProducts ?? 0, change: `${data?.lowStockProducts ?? 0} low stock`, tone: 'success' as const, icon: ShoppingBag },
    { label: 'Total Orders', value: data?.totalOrders ?? 0, change: 'All time', tone: 'brand' as const, icon: CreditCard },
    { label: 'Pending Orders', value: data?.pendingOrders ?? 0, change: 'Needs attention', tone: 'danger' as const, icon: PackageCheck },
    { label: 'Verified Orders', value: data?.verifiedOrders ?? 0, change: 'Paid', tone: 'success' as const, icon: CheckCircle2 },
    { label: 'Total Users', value: data?.totalUsers ?? 0, change: 'Active accounts', tone: 'brand' as const, icon: UsersIcon },
    { label: 'Total Revenue', value: `Rp ${(data?.totalRevenue ?? 0).toLocaleString('id-ID')}`, change: 'Total', tone: 'success' as const, icon: CreditCard },
  ];

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.dashboard}>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {dashboard.isLoading
          ? Array.from({ length: 6 }).map((_, index) => (
              <Card key={index} className="animate-pulse">
                <div className="mb-5 h-11 w-11 rounded-xl bg-gray-100" />
                <div className="space-y-2">
                  <div className="h-4 w-3/4 rounded-md bg-gray-200" />
                  <div className="h-7 w-1/2 rounded-md bg-gray-200" />
                </div>
              </Card>
            ))
          : dashboard.isError
          ? (
            <Card className="col-span-full">
              <p className="p-6 text-sm text-red-600">Unable to load dashboard metrics. Please reauthenticate.</p>
            </Card>
          )
          : stats.map((stat) => {
              const Icon = stat.icon;
              const TrendIcon = stat.tone === 'success' ? ArrowUp : ArrowDown;
              return (
                <Card key={stat.label}>
                  <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-gray-100 text-gray-700">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="text-sm text-gray-500">{stat.label}</p>
                      <p className="mt-2 text-2xl font-semibold text-gray-900">{stat.value}</p>
                    </div>
                    <Badge tone={stat.tone} className="gap-1">
                      <TrendIcon className="h-3 w-3" />
                      {stat.change}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-gray-400">Operational snapshot</p>
                </Card>
              );
            })}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="min-h-[360px]">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Analytics</CardTitle>
              <p className="mt-1 text-sm text-gray-500">Visitor analytics of last 30 days</p>
            </div>
            <div className="flex rounded-xl bg-gray-100 p-1 text-sm">
              {['Monthly', 'Quarterly', 'Annually'].map((item, index) => (
                <button key={item} className={index === 0 ? 'rounded-lg bg-white px-3 py-1.5 text-gray-900 shadow-sm' : 'px-3 py-1.5 text-gray-500'}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="grid h-64 grid-cols-12 items-end gap-3 border-b border-gray-100 pb-4">
            {[45, 70, 52, 88, 62, 74, 58, 92, 66, 78, 54, 84].map((height, index) => (
              <div key={index} className="flex h-full items-end rounded-t-lg bg-indigo-50">
                <div className="w-full rounded-t-lg bg-[#465fff]" style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Order Status</CardTitle>
          <div className="mt-6 flex items-center justify-center">
            <div className="flex h-40 w-40 items-center justify-center rounded-full border-[18px] border-indigo-100">
              <div className="text-center">
                <p className="text-3xl font-semibold text-gray-900">{Object.values(data?.ordersByStatus ?? {}).reduce((sum, value) => sum + value, 0)}</p>
                <p className="text-xs text-gray-500">Total orders</p>
              </div>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-xl font-semibold">{data?.ordersByStatus.PROCESSING ?? 0}</p>
              <p className="text-xs text-gray-500">Processing</p>
            </div>
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-xl font-semibold">{data?.ordersByStatus.DELIVERING ?? 0}</p>
              <p className="text-xs text-gray-500">Delivering</p>
            </div>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card>
          <CardTitle>Top Channels</CardTitle>
          <div className="mt-5 space-y-4">
            {[
              ['Google', '4.7K', 79],
              ['Instagram', '3.4K', 62],
              ['WhatsApp', '2.9K', 51],
              ['Direct', '1.5K', 34],
            ].map(([name, value, progress]) => (
              <div key={name}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-gray-600">{name}</span>
                  <span className="font-medium text-gray-900">{value}</span>
                </div>
                <Progress value={Number(progress)} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Sessions By Device</CardTitle>
          <div className="mt-5 space-y-4">
            {[
              ['Mobile', 68],
              ['Desktop', 24],
              ['Tablet', 8],
            ].map(([name, value]) => (
              <div key={name}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-gray-600">{name}</span>
                  <span className="font-medium text-gray-900">{value}%</span>
                </div>
                <Progress value={Number(value)} />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Customers Demographic</CardTitle>
          <p className="mt-1 text-sm text-gray-500">Number of customers by city</p>
          <div className="mt-5 space-y-4">
            {[
              ['Jakarta', '2,379 Customers', 79],
              ['Bandung', '589 Customers', 23],
              ['Bekasi', '412 Customers', 17],
            ].map(([city, customers, value]) => (
              <div key={city} className="flex items-center justify-between">
                <div>
                  <p className="font-medium text-gray-800">{city}</p>
                  <p className="text-xs text-gray-500">{customers}</p>
                </div>
                <Badge tone="brand">{value}%</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Recent Orders</CardTitle>
          <button className="text-sm font-medium text-[#465fff]">See all</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-3 font-medium">Products</th>
                <th className="py-3 font-medium">Category</th>
                <th className="py-3 font-medium">Payment</th>
                <th className="py-3 font-medium">Status</th>
                <th className="py-3 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {orders.data?.slice(0, 5).map((order) => (
                <tr key={order.id} className="border-b border-gray-50 last:border-0">
                  <td className="py-4 font-medium text-gray-800">{order.orderNumber}</td>
                  <td className="py-4 text-gray-500">{order.user?.name ?? '-'}</td>
                  <td className="py-4 text-gray-500">{order.payment?.status ?? order.paymentMethod}</td>
                  <td className="py-4">
                    <Badge tone={order.status === 'COMPLETED' ? 'success' : 'brand'}>{order.status}</Badge>
                  </td>
                  <td className="py-4 text-right font-semibold text-gray-900">Rp {order.totalPrice.toLocaleString('id-ID')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </AdminShell>
  );
}
