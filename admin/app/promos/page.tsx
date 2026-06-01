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
import { fetchAdminPromos, AdminPromo } from '@/lib/admin';

const activeOptions = ['ALL', 'ACTIVE', 'INACTIVE'] as const;

export default function PromosPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<typeof activeOptions[number]>('ALL');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-promos'],
    queryFn: fetchAdminPromos,
    retry: false,
  });

  const promos = useMemo(() => {
    if (!data) return [];
    return data.filter((promo: AdminPromo) => {
      const matchesSearch = [promo.code, promo.title, promo.description]
        .some((field) => field.toLowerCase().includes(search.toLowerCase()));
      const matchesStatus =
        statusFilter === 'ALL' || (statusFilter === 'ACTIVE' ? promo.isActive : !promo.isActive);
      return matchesSearch && matchesStatus;
    });
  }, [data, search, statusFilter]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.promos}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Voucher Management</h2>
          <p className="mt-1 text-sm text-gray-500">Manage promo codes, discounts, and campaign scheduling.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.promoCreate}>
          <Link href="/promos/new">
            <Button>New Voucher</Button>
          </Link>
        </PermissionGate>
      </div>
      <Card>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search vouchers by code or title"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
          />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof activeOptions[number])}
            className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
          >
            {activeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <CardTitle>Active Vouchers</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading vouchers…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load vouchers. Please reauthenticate.</p>
          ) : promos.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No vouchers match the current filters.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Code</th>
                  <th className="py-3 font-medium">Title</th>
                  <th className="py-3 font-medium">Type</th>
                  <th className="py-3 font-medium">Value</th>
                  <th className="py-3 font-medium">Min. Order</th>
                  <th className="py-3 font-medium">Usage</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {promos.map((promo) => (
                  <tr key={promo.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{promo.code}</td>
                    <td className="py-4 text-gray-600">{promo.title}</td>
                    <td className="py-4 text-gray-500">{promo.voucherType.replaceAll('_', ' ')}</td>
                    <td className="py-4 text-gray-500">
                      {promo.voucherType === 'PERCENTAGE_DISCOUNT' && promo.discountPercentage !== undefined
                        ? `${promo.discountPercentage}%${promo.maxDiscountAmount ? `, max Rp ${promo.maxDiscountAmount.toLocaleString('id-ID')}` : ''}`
                        : promo.voucherType === 'FIXED_DISCOUNT'
                        ? `Rp ${promo.discountAmount?.toLocaleString('id-ID') ?? 0}`
                        : `Free Shipping${promo.freeShippingMaxAmount ? `, max Rp ${promo.freeShippingMaxAmount.toLocaleString('id-ID')}` : ''}`}
                    </td>
                    <td className="py-4 text-gray-500">Rp {promo.minimumOrderAmount.toLocaleString('id-ID')}</td>
                    <td className="py-4 text-gray-500">{promo.currentUsageCount}{promo.maxUsageCount ? ` / ${promo.maxUsageCount}` : ' / ∞'}</td>
                    <td className="py-4">
                      <Badge tone={promo.isActive ? 'success' : 'neutral'}>{promo.isActive ? 'Active' : 'Inactive'}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/promos/${promo.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        View
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
