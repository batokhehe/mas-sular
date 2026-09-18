'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { AdminTopping, fetchAdminToppings, updateAdminTopping } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmStatusChange, runWithFeedback } from '@/lib/admin-alert';
import { toppingStatusLabel } from '@/lib/toppings/topping-form';
import { formatRupiahExact } from '@/lib/utils/number';

export default function ToppingsPage() {
  const [search, setSearch] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-toppings'],
    queryFn: fetchAdminToppings,
    retry: false,
  });

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => updateAdminTopping(id, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-toppings'] }),
  });

  const toppings = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return term ? data.filter((topping) => topping.name.toLowerCase().includes(term)) : data;
  }, [data, search]);

  const activeCount = (data ?? []).filter((topping) => topping.isActive).length;

  const toggle = (topping: AdminTopping) => {
    const next = !topping.isActive;
    void runWithFeedback({
      confirm: () =>
        confirmStatusChange(toppingStatusLabel(topping).label, toppingStatusLabel({ isActive: next }).label, {
          title: `${next ? 'Aktifkan' : 'Nonaktifkan'} ${topping.name}?`,
        }),
      loading: ADMIN_LOADING_MESSAGES.statusUpdate,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => setActive.mutateAsync({ id: topping.id, isActive: next }),
    });
  };

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.toppings}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Topping Management</h2>
          <p className="mt-1 text-sm text-gray-500">
            Tambahan opsional yang bisa ditambahkan pelanggan ke produk apa pun. Hanya topping aktif yang ditawarkan saat checkout.
          </p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.toppingCreate}>
          <Link href="/toppings/new">
            <Button type="button">Tambah Topping</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <div className="mb-4">
          <input
            id="topping-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari topping berdasarkan nama"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white md:max-w-md"
          />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle>Topping</CardTitle>
          {data ? (
            <p className="text-sm text-gray-500">
              {data.length} topping · {activeCount} aktif
            </p>
          ) : null}
        </div>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat topping...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat topping. Silakan masuk ulang.</p>
          ) : toppings.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">{data?.length ? 'Tidak ada topping yang cocok dengan pencarian.' : 'Belum ada topping.'}</p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Nama</th>
                  <th className="py-3 font-medium">Harga</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {toppings.map((topping) => {
                  const status = toppingStatusLabel(topping);
                  return (
                    <tr key={topping.id} className="border-b border-gray-50 last:border-0">
                      <td className="py-4 font-medium text-gray-800">{topping.name}</td>
                      <td className="py-4 tabular-nums text-gray-700">{formatRupiahExact(topping.price)}</td>
                      <td className="py-4">
                        <Badge tone={status.tone === 'active' ? 'success' : 'neutral'}>{status.label}</Badge>
                      </td>
                      <td className="py-4">
                        <PermissionGate
                          permissions={ROUTE_PERMISSIONS.toppingUpdate}
                          fallback={<span className="text-xs text-gray-400">Hanya lihat</span>}
                        >
                          <div className="flex flex-wrap items-center gap-4">
                            <Link href={`/toppings/${topping.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                              Ubah
                            </Link>
                            <button
                              type="button"
                              onClick={() => toggle(topping)}
                              disabled={setActive.isPending}
                              className="text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                            >
                              {topping.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                            </button>
                          </div>
                        </PermissionGate>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
