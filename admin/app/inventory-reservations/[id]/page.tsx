'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchReservation } from '@/lib/admin';

export default function ReservationDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : undefined;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-reservation', id],
    queryFn: () => (id ? fetchReservation(id) : Promise.reject(new Error('Missing id'))),
    enabled: Boolean(id),
    retry: false,
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.inventoryReservations}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Reservation Detail</h2>
          <p className="mt-1 text-sm text-gray-500">Stock hold and its lifecycle timeline.</p>
        </div>
        <Link href="/inventory-reservations" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to reservations
        </Link>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : isError || !data ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">Unable to load this reservation.</div>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
          <Card>
            <CardTitle>Summary</CardTitle>
            <div className="mt-4 grid gap-4 text-sm text-gray-700 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-gray-400">Status</p>
                <Badge className="mt-2" tone={data.status === 'EXPIRED' || data.status === 'CANCELLED' ? 'danger' : data.status === 'COMMITTED' ? 'success' : 'brand'}>
                  {data.status}
                </Badge>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Order</p>
                <p className="mt-2 font-medium text-gray-900">{data.order?.orderNumber ?? '—'}</p>
                <p className="text-gray-500">{data.order?.user?.name ?? ''}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Product</p>
                <p className="mt-2 font-medium text-gray-900">{data.product?.name ?? data.productId}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Outlet</p>
                <p className="mt-2 font-medium text-gray-900">{data.outlet?.name ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Quantities</p>
                <p className="mt-2 text-gray-700">Reserved {data.reservedQty} · Committed {data.committedQty} · Released {data.releasedQty}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Expires</p>
                <p className="mt-2 text-gray-700">{data.expiresAt ? new Date(data.expiresAt).toLocaleString('id-ID') : 'No expiry'}</p>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle>Timeline</CardTitle>
            <ol className="mt-4 space-y-0">
              {(data.history ?? []).length === 0 ? (
                <p className="text-sm text-gray-500">No history recorded.</p>
              ) : (
                (data.history ?? []).map((h, index, arr) => (
                  <li key={h.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className="flex h-3.5 w-3.5 rounded-full border border-[#465fff] bg-[#465fff]" />
                      {index < arr.length - 1 ? <span className="w-px flex-1 bg-[#465fff]" style={{ minHeight: 20 }} /> : null}
                    </div>
                    <div className="pb-4">
                      <p className="text-sm font-medium text-gray-900">{h.status}</p>
                      {h.note ? <p className="text-xs text-gray-500">{h.note}</p> : null}
                      <p className="text-xs text-gray-400">{new Date(h.createdAt).toLocaleString('id-ID')}</p>
                    </div>
                  </li>
                ))
              )}
            </ol>
          </Card>
        </div>
      )}
    </AdminShell>
  );
}
