'use client';

import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { adjustStock, fetchProductInventory, ProductInventoryRow } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function ProductInventoryPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-product-inventory', search, page, limit],
    queryFn: () => fetchProductInventory({ search, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const [editing, setEditing] = useState<ProductInventoryRow | null>(null);
  const [value, setValue] = useState('');

  const mutation = useMutation({
    mutationFn: (row: ProductInventoryRow) => adjustStock({ productId: row.productId, outletId: row.outletId, stock: Number(value) }),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['admin-product-inventory'] });
    },
  });

  const save = (row: ProductInventoryRow) =>
    runWithFeedback({
      loading: ADMIN_LOADING_MESSAGES.update,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => mutation.mutateAsync(row),
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productInventory}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Stok Produk</h2>
        <p className="mt-1 text-sm text-gray-500">Stok per outlet (sumber data utama). Stok yang direservasi dikurangkan dari stok tersedia.</p>
      </div>
      <Card>
        <div className="flex items-end gap-3">
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Cari</span>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Produk atau outlet…" className="h-11 w-60 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]" />
          </label>
        </div>
        <div className="mt-5 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat stok.</p>
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">Belum ada data stok. Isi ProductInventory atau tambahkan outlet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Produk</th>
                  <th className="py-3 font-medium">Outlet</th>
                  <th className="py-3 font-medium">Stok</th>
                  <th className="py-3 font-medium">Direservasi</th>
                  <th className="py-3 font-medium">Tersedia</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-3 text-gray-800">{r.product?.name ?? r.productId}</td>
                    <td className="py-3 text-gray-500">{r.outlet?.name ?? r.outletId}</td>
                    <td className="py-3 text-gray-700">{r.stock}</td>
                    <td className="py-3 text-gray-500">{r.reserved}</td>
                    <td className="py-3 font-medium text-gray-900">{r.available}</td>
                    <td className="py-3">
                      <PermissionGate permissions={ROUTE_PERMISSIONS.productInventoryUpdate}>
                        {editing?.id === r.id ? (
                          <span className="flex items-center gap-2">
                            <input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} className="h-9 w-20 rounded-lg border border-gray-200 px-2 text-sm" />
                            <Button className="h-9" onClick={() => save(r)} disabled={mutation.isPending}>Simpan</Button>
                            <button className="text-xs text-gray-500" onClick={() => setEditing(null)}>Batal</button>
                          </span>
                        ) : (
                          <button className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#465fff] ring-1 ring-gray-200 hover:bg-gray-50" onClick={() => { setEditing(r); setValue(String(r.stock)); }}>
                            Sesuaikan
                          </button>
                        )}
                      </PermissionGate>
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
