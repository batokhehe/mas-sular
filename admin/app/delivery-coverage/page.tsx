'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { formatRupiahExact } from '@/lib/utils/number';
import {
  AdminDeliveryCoverage,
  CoverageType,
  DeliveryCoverageFilters,
  deleteDeliveryCoverage,
  fetchDeliveryCoverages,
  setDeliveryCoverageActive,
} from '@/lib/admin';
import {
  ADMIN_LOADING_MESSAGES,
  ADMIN_SUCCESS_MESSAGES,
  confirmDelete,
  confirmStatusChange,
  runWithFeedback,
} from '@/lib/admin-alert';

const rupiah = formatRupiahExact;

const coverageBadge = (type: CoverageType) => {
  if (type === 'DELIVERY') return <Badge tone="success">Delivery</Badge>;
  if (type === 'PICKUP_ONLY') return <Badge tone="brand">Pickup Only</Badge>;
  return <Badge tone="danger">Disabled</Badge>;
};

export default function DeliveryCoveragePage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [coverageType, setCoverageType] = useState<CoverageType | ''>('');
  const [isActive, setIsActive] = useState<'true' | 'false' | ''>('');

  const filters: DeliveryCoverageFilters = { search, coverageType, isActive };
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-delivery-coverage', filters],
    queryFn: () => fetchDeliveryCoverages(filters),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-delivery-coverage'] });
  const toggleMutation = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => setDeliveryCoverageActive(id, next),
    onSuccess: refresh,
  });
  const deleteMutation = useMutation({ mutationFn: deleteDeliveryCoverage, onSuccess: refresh });

  const handleToggle = (row: AdminDeliveryCoverage) =>
    runWithFeedback({
      confirm: () =>
        confirmStatusChange(row.isActive ? 'Active' : 'Disabled', row.isActive ? 'Disabled' : 'Active', {
          title: row.isActive ? 'Disable this coverage?' : 'Enable this coverage?',
        }),
      loading: ADMIN_LOADING_MESSAGES.update,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => toggleMutation.mutateAsync({ id: row.id, next: !row.isActive }),
    });

  const handleDelete = (id: string) =>
    runWithFeedback({
      confirm: () => confirmDelete('Delivery Coverage'),
      loading: ADMIN_LOADING_MESSAGES.delete,
      success: ADMIN_SUCCESS_MESSAGES.deleted('Delivery Coverage'),
      action: () => deleteMutation.mutateAsync(id),
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.deliveryCoverage}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Delivery Coverage</h2>
          <p className="mt-1 text-sm text-gray-500">Configure which areas can receive delivery, pickup-only, or are disabled.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.deliveryCoverageCreate}>
          <Link href="/delivery-coverage/new">
            <Button>Add Coverage</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Search</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Province, city, district…"
              className="h-11 w-56 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            />
          </label>
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Type</span>
            <select
              value={coverageType}
              onChange={(e) => setCoverageType(e.target.value as CoverageType | '')}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              <option value="">All types</option>
              <option value="DELIVERY">Delivery</option>
              <option value="PICKUP_ONLY">Pickup Only</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </label>
          <label className="space-y-1 text-sm text-gray-600">
            <span className="block text-xs uppercase text-gray-400">Status</span>
            <select
              value={isActive}
              onChange={(e) => setIsActive(e.target.value as 'true' | 'false' | '')}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              <option value="">All statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </label>
        </div>

        <div className="mt-5 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading coverage rules…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load coverage rules. Please reauthenticate.</p>
          ) : (data?.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-gray-500">No coverage rules match your filters.</p>
          ) : (
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Province</th>
                  <th className="py-3 font-medium">City</th>
                  <th className="py-3 font-medium">District</th>
                  <th className="py-3 font-medium">Village</th>
                  <th className="py-3 font-medium">Type</th>
                  <th className="py-3 font-medium">Delivery Fee</th>
                  <th className="py-3 font-medium">Min. Order</th>
                  <th className="py-3 font-medium">Est. Delivery</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((row) => (
                  <tr key={row.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 text-gray-800">{row.province?.name ?? '—'}</td>
                    <td className="py-4 text-gray-800">{row.city?.name ?? '—'}</td>
                    <td className="py-4 text-gray-500">{row.district?.name ?? 'All'}</td>
                    <td className="py-4 text-gray-500">{row.village?.name ?? 'All'}</td>
                    <td className="py-4">{coverageBadge(row.coverageType)}</td>
                    <td className="py-4 text-gray-500">{row.coverageType === 'DELIVERY' ? rupiah(row.deliveryFee) : '—'}</td>
                    <td className="py-4 text-gray-500">{row.coverageType === 'DELIVERY' ? rupiah(row.minimumOrder) : '—'}</td>
                    <td className="py-4 text-gray-500">{row.estimatedMinutes} min</td>
                    <td className="py-4">
                      {row.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="brand">Inactive</Badge>}
                    </td>
                    <td className="py-4">
                      <div className="flex items-center gap-2">
                        <PermissionGate permissions={ROUTE_PERMISSIONS.deliveryCoverageUpdate}>
                          <button
                            onClick={() => handleToggle(row)}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-[#465fff] ring-1 ring-gray-200 hover:bg-gray-50"
                          >
                            {row.isActive ? 'Disable' : 'Enable'}
                          </button>
                        </PermissionGate>
                        <PermissionGate permissions={ROUTE_PERMISSIONS.deliveryCoverageUpdate}>
                          <Link
                            href={`/delivery-coverage/${row.id}`}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
                          >
                            Edit
                          </Link>
                        </PermissionGate>
                        <PermissionGate permissions={ROUTE_PERMISSIONS.deliveryCoverageDelete}>
                          <button
                            onClick={() => handleDelete(row.id)}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-600 ring-1 ring-gray-200 hover:bg-gray-50"
                          >
                            Delete
                          </button>
                        </PermissionGate>
                      </div>
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
