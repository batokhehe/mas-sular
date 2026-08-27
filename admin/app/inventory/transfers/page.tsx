'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  approveTransfer,
  completeTransfer,
  fetchProductInventory,
  fetchTransfers,
  requestTransfer,
  StockTransferRow,
  TransferStatus,
} from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

const tone: Record<TransferStatus, 'success' | 'brand' | 'danger'> = {
  REQUESTED: 'brand',
  APPROVED: 'brand',
  COMPLETED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'danger',
};

export default function StockTransferPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const { data, isLoading } = useQuery({
    queryKey: ['admin-transfers', page, limit],
    queryFn: () => fetchTransfers({ page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Dropdown source: pull the largest allowed page so the form lists as many
  // products/outlets as possible (deduped below).
  const { data: inventory } = useQuery({ queryKey: ['admin-product-inventory', 'transfer-options'], queryFn: () => fetchProductInventory({ limit: 100 }), retry: false });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-transfers'] });
  const approveM = useMutation({ mutationFn: approveTransfer, onSuccess: refresh });
  const completeM = useMutation({ mutationFn: completeTransfer, onSuccess: refresh });
  const requestM = useMutation({ mutationFn: requestTransfer, onSuccess: refresh });

  const inventoryRows = inventory?.items ?? [];
  const products = Array.from(new Map(inventoryRows.map((r) => [r.productId, r.product?.name ?? r.productId])).entries());
  const outlets = Array.from(new Map(inventoryRows.map((r) => [r.outletId, r.outlet?.name ?? r.outletId])).entries());

  const [form, setForm] = useState({ productId: '', fromOutletId: '', toOutletId: '', quantity: '' });

  const submit = () =>
    runWithFeedback({
      loading: ADMIN_LOADING_MESSAGES.create,
      success: ADMIN_SUCCESS_MESSAGES.created('Transfer'),
      action: () =>
        requestM.mutateAsync({
          productId: form.productId,
          fromOutletId: form.fromOutletId,
          toOutletId: form.toOutletId,
          quantity: Number(form.quantity),
        }),
    });

  const act = (fn: () => Promise<StockTransferRow>, label: string) =>
    runWithFeedback({ loading: ADMIN_LOADING_MESSAGES.update, success: label, action: fn });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.stockTransfers}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Stock Transfer</h2>
        <p className="mt-1 text-sm text-gray-500">Move stock between outlets. Requested → Approved → Completed.</p>
      </div>

      <PermissionGate permissions={ROUTE_PERMISSIONS.stockTransferCreate}>
        <Card className="mb-5">
          <CardTitle>New transfer</CardTitle>
          <div className="mt-4 grid gap-3 lg:grid-cols-5">
            <select value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })} className="h-11 rounded-xl border border-gray-200 px-3 text-sm">
              <option value="">Product…</option>
              {products.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={form.fromOutletId} onChange={(e) => setForm({ ...form, fromOutletId: e.target.value })} className="h-11 rounded-xl border border-gray-200 px-3 text-sm">
              <option value="">From outlet…</option>
              {outlets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <select value={form.toOutletId} onChange={(e) => setForm({ ...form, toOutletId: e.target.value })} className="h-11 rounded-xl border border-gray-200 px-3 text-sm">
              <option value="">To outlet…</option>
              {outlets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            <input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value.replace(/\D/g, '') })} placeholder="Qty" className="h-11 rounded-xl border border-gray-200 px-3 text-sm" />
            <Button onClick={submit} disabled={requestM.isPending || !form.productId || !form.fromOutletId || !form.toOutletId || !form.quantity}>Request</Button>
          </div>
        </Card>
      </PermissionGate>

      <Card>
        <CardTitle>Transfers</CardTitle>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading…</p>
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">No transfers yet.</p>
          ) : (
            data?.items.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4">
                <div>
                  <p className="font-medium text-gray-800">
                    {t.product?.name ?? t.productId} · {t.quantity} units
                  </p>
                  <p className="text-sm text-gray-500">
                    {t.fromOutlet?.name ?? '—'} → {t.toOutlet?.name ?? '—'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={tone[t.status]}>{t.status}</Badge>
                  <PermissionGate permissions={ROUTE_PERMISSIONS.stockTransferUpdate}>
                    {t.status === 'REQUESTED' ? (
                      <Button onClick={() => act(() => approveM.mutateAsync(t.id), 'Transfer approved')}>Approve</Button>
                    ) : null}
                    {t.status === 'APPROVED' ? (
                      <Button onClick={() => act(() => completeM.mutateAsync(t.id), 'Transfer completed')}>Complete</Button>
                    ) : null}
                  </PermissionGate>
                </div>
              </div>
            ))
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
