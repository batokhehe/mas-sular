'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminOrders, AdminOrder } from '@/lib/admin';
import { PrepareShipmentPanel } from './components/prepare-shipment-panel';

const statusOptions = ['ALL', 'PENDING', 'PROCESSING', 'PACKING', 'DELIVERING', 'COMPLETED', 'CANCELLED'] as const;

/**
 * Only these can be handed to a courier. PACKING is the existing state for an
 * order being prepared; PROCESSING is where a paid order lands. Anything else
 * is either not paid for yet or already gone, so it cannot be selected.
 */
const BOOKABLE_STATUSES = new Set(['PROCESSING', 'PACKING']);

export default function OrdersPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<typeof statusOptions[number]>('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-orders', statusFilter, page, limit],
    queryFn: () => fetchAdminOrders({ status: statusFilter === 'ALL' ? undefined : statusFilter, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Free-text search stays client-side over the current page; status filtering
  // and paging are handled server-side.
  const orders = useMemo(() => {
    if (!data) return [];
    return data.items.filter((order: AdminOrder) =>
      [order.orderNumber, order.user?.name ?? '', order.user?.email ?? ''].some((field) =>
        field.toLowerCase().includes(search.toLowerCase()),
      ),
    );
  }, [data, search]);

  const selectedOrders = useMemo(
    () => orders.filter((order: AdminOrder) => selectedIds.has(order.id)),
    [orders, selectedIds],
  );

  function toggle(order: AdminOrder) {
    // Guard here as well as in the checkbox: an ineligible order must never
    // reach the packing action, whatever the UI state.
    if (!BOOKABLE_STATUSES.has(order.status)) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(order.id)) next.delete(order.id);
      else next.add(order.id);
      return next;
    });
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.orders}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Order Management</h2>
        <p className="mt-1 text-sm text-gray-500">Track checkout, fulfillment, delivery, and customer support states.</p>
      </div>
      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search order number, customer, or email"
              className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as typeof statusOptions[number]);
              setPage(1);
            }}
            className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
          >
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        {selectedOrders.length > 0 ? (
          <PrepareShipmentPanel
            selected={selectedOrders}
            onDone={() => void refetch()}
            onClear={() => setSelectedIds(new Set())}
          />
        ) : null}

        <CardTitle>Recent Orders</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading orders...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load orders. Please reauthenticate.</p>
          ) : orders.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No orders match the current filters.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="w-8 py-3 font-medium"><span className="sr-only">Select</span></th>
                  <th className="py-3 font-medium">Order</th>
                  <th className="py-3 font-medium">Customer</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Payment</th>
                  <th className="py-3 text-right font-medium">Total</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4">
                      <input
                        type="checkbox"
                        aria-label={`Select ${order.orderNumber}`}
                        checked={selectedIds.has(order.id)}
                        onChange={() => toggle(order)}
                        disabled={!BOOKABLE_STATUSES.has(order.status)}
                        title={BOOKABLE_STATUSES.has(order.status) ? undefined : 'Only paid orders being processed or packed can be shipped'}
                        className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </td>
                    <td className="py-4 font-medium text-gray-800">{order.orderNumber}</td>
                    <td className="py-4 text-gray-500">{order.user?.name ?? '-'}</td>
                    <td className="py-4">
                      <Badge tone={order.status === 'COMPLETED' ? 'success' : order.status === 'PENDING' ? 'danger' : 'brand'}>
                        {order.status}
                      </Badge>
                    </td>
                    <td className="py-4 text-gray-500">{order.payment?.status ?? order.paymentMethod}</td>
                    <td className="py-4 text-right font-semibold text-gray-900">Rp {order.totalPrice.toLocaleString('id-ID')}</td>
                    <td className="py-4">
                      <Link href={`/orders/${order.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.total > 0 ? (
          <Pagination
            page={data.page}
            limit={data.limit}
            total={data.total}
            totalPages={data.totalPages}
            onPageChange={setPage}
            onLimitChange={(l) => {
              setLimit(l);
              setPage(1);
            }}
          />
        ) : null}
      </Card>
    </AdminShell>
  );
}
