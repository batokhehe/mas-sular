'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminRoles, AdminRole } from '@/lib/admin';

export default function RolesPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: fetchAdminRoles,
    retry: false,
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roles}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Manajemen Peran & Izin</h2>
          <p className="mt-1 text-sm text-gray-500">Matriks RBAC untuk kemampuan admin, manajer, staf, dan pelanggan.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.roleCreate}>
          <Link href="/roles/new">
            <Button>Buat Peran</Button>
          </Link>
        </PermissionGate>
      </div>
      <Card>
        <CardTitle>Peran</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat peran...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat peran. Silakan masuk ulang.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada peran ditemukan.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Peran</th>
                  <th className="py-3 font-medium">Deskripsi</th>
                  <th className="py-3 font-medium">Izin</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((role: AdminRole) => (
                  <tr key={role.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{role.name}</td>
                    <td className="py-4 text-gray-500">{role.description ?? '-'}</td>
                    <td className="py-4 text-gray-500">
                      {role.permissions.map((assignment) => `${assignment.permission.subject}:${assignment.permission.action}`).join(', ') || 'None'}
                    </td>
                    <td className="py-4">
                      <Link href={`/roles/${role.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        Lihat
                      </Link>
                    </td>
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
