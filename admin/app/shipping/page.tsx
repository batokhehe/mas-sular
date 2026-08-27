'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminShipments, AdminShipment } from '@/lib/admin';
import { shipmentServiceDisplay, shipmentServiceSearchTerms } from '@/lib/shipments/service-display';

const statusOptions = ['ALL', 'PENDING', 'RATE_SELECTED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'FAILED'] as const;

export default function ShippingPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<typeof statusOptions[number]>('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-shipments', statusFilter, page, limit],
    queryFn: () => fetchAdminShipments({ status: statusFilter === 'ALL' ? undefined : statusFilter, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Free-text search stays client-side over the current page; status filtering
  // and paging are handled server-side.
  const shipments = useMemo(() => {
    if (!data) return [];
    return data.items.filter((shipment: AdminShipment) =>
      [
        shipment.order.orderNumber,
        shipment.provider,
        // Search every representation: legacy rows hold a label, the order
        // holds the paid code. Read-time compatibility, never a migration.
        ...shipmentServiceSearchTerms(shipment),
        shipment.trackingNumber ?? '',
      ].some((field) =>
        field.toLowerCase().includes(search.toLowerCase()),
      ),
    );
  }, [data, search]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipments}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Shipping Management</h2>
          <p className="mt-1 text-sm text-gray-500">Provider rates, shipment status, and tracking updates.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.shipmentCreate}>
          <Link href="/shipping/new">
            <Button>New Shipment</Button>
          </Link>
        </PermissionGate>
      </div>
      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search shipments by order, provider, or tracking"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
          />
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

        <CardTitle>Shipments</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading shipments...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load shipments. Please reauthenticate.</p>
          ) : shipments.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No shipments match the current filters.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Order</th>
                  <th className="py-3 font-medium">Provider</th>
                  <th className="py-3 font-medium">Service</th>
                  <th className="py-3 font-medium">Tracking</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shipments.map((shipment) => (
                  <tr key={shipment.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{shipment.order.orderNumber}</td>
                    <td className="py-4 text-gray-500">{shipment.provider}</td>
                    <td className="py-4 text-gray-500">{shipmentServiceDisplay(shipment)}</td>
                    <td className="py-4 text-gray-500">{shipment.trackingNumber ?? '-'}</td>
                    <td className="py-4">
                      <Badge tone={shipment.status === 'DELIVERED' ? 'success' : 'brand'}>{shipment.status}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/shipping/${shipment.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
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
