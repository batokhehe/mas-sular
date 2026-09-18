'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { AdminBanner, fetchAdminBanners } from '@/lib/admin';

export default function BannersPage() {
  const [search, setSearch] = useState('');
  const [placementFilter, setPlacementFilter] = useState('ALL');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-banners'],
    queryFn: fetchAdminBanners,
    retry: false,
  });

  const placements = useMemo(() => ['ALL', ...Array.from(new Set((data ?? []).map((banner) => banner.placement)))], [data]);
  const banners = useMemo(() => {
    if (!data) return [];
    return data.filter((banner) => {
      const matchesSearch = [banner.title, banner.description ?? '', banner.placement]
        .some((field) => field.toLowerCase().includes(search.toLowerCase()));
      const matchesPlacement = placementFilter === 'ALL' || banner.placement === placementFilter;
      return matchesSearch && matchesPlacement;
    });
  }, [data, placementFilter, search]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.banners}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Banner Management</h2>
          <p className="mt-1 text-sm text-gray-500">Kelola penempatan banner beranda dan kampanye.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.bannerCreate}>
          <Link href="/banners/new">
            <Button type="button">Tambah Banner</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cari banner berdasarkan judul atau penempatan"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
          />
          <select
            value={placementFilter}
            onChange={(event) => setPlacementFilter(event.target.value)}
            className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
          >
            {placements.map((placement) => (
              <option key={placement} value={placement}>
                {placement.replaceAll('_', ' ')}
              </option>
            ))}
          </select>
        </div>

        <CardTitle>Banner</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat banner...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat banner. Silakan masuk ulang.</p>
          ) : banners.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada banner yang cocok dengan filter.</p>
          ) : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Judul</th>
                  <th className="py-3 font-medium">Penempatan</th>
                  <th className="py-3 font-medium">Urutan</th>
                  <th className="py-3 font-medium">Jadwal</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {banners.map((banner: AdminBanner) => (
                  <tr key={banner.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{banner.title}</td>
                    <td className="py-4 text-gray-500">{banner.placement.replaceAll('_', ' ')}</td>
                    <td className="py-4 text-gray-500">{banner.sortOrder}</td>
                    <td className="py-4 text-gray-500">
                      {banner.startsAt ? new Date(banner.startsAt).toLocaleDateString('id-ID') : 'Anytime'}
                      {' - '}
                      {banner.endsAt ? new Date(banner.endsAt).toLocaleDateString('id-ID') : 'Tanpa akhir'}
                    </td>
                    <td className="py-4">
                      <Badge tone={banner.isActive ? 'success' : 'neutral'}>{banner.isActive ? 'Aktif' : 'Nonaktif'}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/banners/${banner.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
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
