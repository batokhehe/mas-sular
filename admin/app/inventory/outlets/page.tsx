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
        <h2 className="text-xl font-semibold text-gray-900">Outlet Inventory</h2>
        <p className="mt-1 text-sm text-gray-500">Aggregated stock / reserved / available / committed per outlet.</p>
      </div>
      <Card>
        <CardTitle>Inventory by outlet</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load report.</p>
          ) : (data?.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">No per-outlet inventory yet.</p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Outlet</th>
                  <th className="py-3 font-medium">Stock</th>
                  <th className="py-3 font-medium">Reserved</th>
                  <th className="py-3 font-medium">Available</th>
                  <th className="py-3 font-medium">Committed</th>
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
