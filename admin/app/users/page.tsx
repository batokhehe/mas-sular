'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminUsers, AdminUser } from '@/lib/admin';

export default function UsersPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-users'],
    queryFn: fetchAdminUsers,
    retry: false,
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.users}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Manajemen Pengguna</h2>
        <p className="mt-1 text-sm text-gray-500">Pelanggan, admin, dan penetapan peran.</p>
      </div>
      <Card>
        <CardTitle>Pengguna</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat pengguna...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat pengguna. Silakan masuk ulang.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada pengguna ditemukan.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Nama</th>
                  <th className="py-3 font-medium">Email</th>
                  <th className="py-3 font-medium">Telepon</th>
                  <th className="py-3 font-medium">Peran</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((user: AdminUser) => (
                  <tr key={user.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{user.name}</td>
                    <td className="py-4 text-gray-500">{user.email}</td>
                    <td className="py-4 text-gray-500">{user.phone ?? '-'}</td>
                    <td className="py-4 text-gray-500">
                      {user.roles.map((assignment) => assignment.role.name).join(', ') || 'Customer'}
                    </td>
                    <td className="py-4">
                      <Badge tone={user.isActive ? 'success' : 'danger'}>{user.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/users/${user.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
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
