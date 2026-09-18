'use client';

import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchInventoryReport } from '@/lib/admin';

export default function OutletInventoryPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-inventory-report'],
    queryFn: fetchInventoryReport,
    retry: false,
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productInventory}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Stok Outlet</h2>
        <p className="mt-1 text-sm text-gray-500">Ringkasan stok / direservasi / tersedia / terkonfirmasi per outlet.</p>
      </div>
      <Card>
        <CardTitle>Stok per outlet</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat laporan.</p>
          ) : (data?.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">Belum ada stok per outlet.</p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Outlet</th>
                  <th className="py-3 font-medium">Stok</th>
                  <th className="py-3 font-medium">Direservasi</th>
                  <th className="py-3 font-medium">Tersedia</th>
                  <th className="py-3 font-medium">Terkonfirmasi</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((r) => (
                  <tr key={r.outletId} className="border-b border-gray-50 last:border-0">
                    <td className="py-3 font-medium text-gray-900">{r.outletName}</td>
                    <td className="py-3 text-gray-700">{r.stock}</td>
                    <td className="py-3 text-gray-500">{r.reserved}</td>
                    <td className="py-3 text-gray-700">{r.available}</td>
                    <td className="py-3 text-gray-500">{r.committed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
