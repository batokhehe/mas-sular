'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchReservations, ReservationFilters, ReservationStatus } from '@/lib/admin';

const statusTone: Record<ReservationStatus, 'success' | 'brand' | 'danger'> = {
  RESERVED: 'brand',
  COMMITTED: 'success',
  RELEASED: 'brand',
  EXPIRED: 'danger',
  CANCELLED: 'danger',
};

function statusBadge(status: ReservationStatus) {
  return <Badge tone={statusTone[status]}>{status}</Badge>;
}

export default function InventoryReservationsPage() {
  const [status, setStatus] = useState<ReservationStatus | ''>('');
  const [expired, setExpired] = useState<'true' | ''>('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const filters: ReservationFilters = { status, expired, search, page, limit };
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-reservations', filters],
    queryFn: () => fetchReservations(filters),
    placeholderData: keepPreviousData,
    retry: false,
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.inventoryReservations}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Inventory Reservations</h2>
        <p className="mt-1 text-sm text-gray-500">
          Stock holds per order. Reserved at checkout, committed on payment verification, released on expiry/cancel.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Search</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Order number or product…"
              className="h-11 w-60 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            />
          </label>
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Status</span>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as ReservationStatus | '');
                setPage(1);
              }}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              <option value="">All statuses</option>
              {(['RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED', 'CANCELLED'] as ReservationStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Expired</span>
            <select
              value={expired}
              onChange={(e) => {
                setExpired(e.target.value as 'true' | '');
                setPage(1);
              }}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              <option value="">All</option>
              <option value="true">Past expiry</option>
            </select>
          </label>
        </div>

        <div className="mt-5 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading reservations…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load reservations. Please reauthenticate.</p>
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">No reservations match your filters.</p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Reservation</th>
                  <th className="py-3 font-medium">Order</th>
                  <th className="py-3 font-medium">Customer</th>
                  <th className="py-3 font-medium">Outlet</th>
                  <th className="py-3 font-medium">Product</th>
                  <th className="py-3 font-medium">Qty</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Expires</th>
                  <th className="py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60">
                    <td className="py-3">
                      <Link href={`/inventory-reservations/${r.id}`} className="font-medium text-[#465fff]">
                        {r.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="py-3 text-gray-700">{r.order?.orderNumber ?? '—'}</td>
                    <td className="py-3 text-gray-500">{r.order?.user?.name ?? '—'}</td>
                    <td className="py-3 text-gray-500">{r.outlet?.name ?? '—'}</td>
                    <td className="py-3 text-gray-700">{r.product?.name ?? r.productId}</td>
                    <td className="py-3 text-gray-500">{r.reservedQty}</td>
                    <td className="py-3">{statusBadge(r.status)}</td>
                    <td className="py-3 text-gray-500">{r.expiresAt ? new Date(r.expiresAt).toLocaleString('id-ID') : '—'}</td>
                    <td className="py-3 text-gray-500">{new Date(r.createdAt).toLocaleDateString('id-ID')}</td>
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
