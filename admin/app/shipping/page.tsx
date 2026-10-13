'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { shipmentStatusLabel } from '@/lib/status-labels';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminShipments, AdminShipment } from '@/lib/admin';
import { shipmentServiceDisplay } from '@/lib/shipments/service-display';
import {
  matchesShipmentSearch,
  SHIPPING_LIST_SCOPE,
  SHIPPING_STATUS_FILTER_OPTIONS,
  ShippingStatusFilter,
} from '@/lib/shipments/shipping-list';

export default function ShippingPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ShippingStatusFilter>('ALL');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const { data, isLoading, isError } = useQuery({
    // Only active / actionable shipments (not delivered or cancelled, order not final):
    // the server applies the rule, so paging and totals match what is shown.
    queryKey: ['admin-shipments', SHIPPING_LIST_SCOPE, statusFilter, page, limit],
    queryFn: () =>
      fetchAdminShipments({ scope: SHIPPING_LIST_SCOPE, status: statusFilter === 'ALL' ? undefined : statusFilter, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Free-text search stays client-side over the current page; status filtering
  // and paging are handled server-side.
  const shipments = useMemo(() => {
    if (!data) return [];
    return data.items.filter((shipment: AdminShipment) => matchesShipmentSearch(shipment, search));
  }, [data, search]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.shipments}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Manajemen Pengiriman</h2>
          <p className="mt-1 text-sm text-gray-500">Tarif penyedia, status pengiriman, dan pembaruan pelacakan.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.shipmentCreate}>
          <Link href="/shipping/new">
            <Button>Pengiriman Baru</Button>
          </Link>
        </PermissionGate>
      </div>
      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari pengiriman berdasarkan pesanan, penyedia, atau resi"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
          />
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as ShippingStatusFilter);
              setPage(1);
            }}
            className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
          >
            {SHIPPING_STATUS_FILTER_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {status === 'ALL' ? 'Semua' : shipmentStatusLabel(status)}
              </option>
            ))}
          </select>
        </div>

        <CardTitle>Pengiriman</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat pengiriman...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat pengiriman. Silakan masuk ulang.</p>
          ) : shipments.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada pengiriman yang cocok dengan filter.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Pesanan</th>
                  <th className="py-3 font-medium">Penyedia</th>
                  <th className="py-3 font-medium">Layanan</th>
                  <th className="py-3 font-medium">No. Resi</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Aksi</th>
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
                      <Badge tone={shipment.status === 'DELIVERED' ? 'success' : 'brand'}>{shipmentStatusLabel(shipment.status)}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/shipping/${shipment.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        Lihat
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
