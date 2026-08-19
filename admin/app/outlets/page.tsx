'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { AdminOutlet, activateOutlet, deleteOutlet, fetchOutlets } from '@/lib/admin';
import {
  ADMIN_LOADING_MESSAGES,
  ADMIN_SUCCESS_MESSAGES,
  confirmDelete,
  confirmStatusChange,
  runWithFeedback,
} from '@/lib/admin-alert';

function regionLine(outlet: AdminOutlet): string {
  return [outlet.village?.name, outlet.district?.name, outlet.city?.name, outlet.province?.name]
    .filter(Boolean)
    .join(', ');
}

export default function OutletsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-outlets'],
    queryFn: fetchOutlets,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-outlets'] });
  const activateMutation = useMutation({ mutationFn: activateOutlet, onSuccess: refresh });
  const deleteMutation = useMutation({ mutationFn: deleteOutlet, onSuccess: refresh });

  const handleActivate = (id: string) =>
    runWithFeedback({
      confirm: () => confirmStatusChange('Inactive', 'Active', { title: 'Activate this outlet?' }),
      loading: ADMIN_LOADING_MESSAGES.update,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => activateMutation.mutateAsync(id),
    });

  const handleDelete = (id: string) =>
    runWithFeedback({
      confirm: () => confirmDelete('Outlet'),
      loading: ADMIN_LOADING_MESSAGES.delete,
      success: ADMIN_SUCCESS_MESSAGES.deleted('Outlet'),
      action: () => deleteMutation.mutateAsync(id),
    });

  const hasActive = (data ?? []).some((o) => o.isActive);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.outlets}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Outlet Configuration</h2>
          <p className="mt-1 text-sm text-gray-500">
            Shipping providers always use the active outlet as the origin. Exactly one outlet is active.
          </p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.outletCreate}>
          <Link href="/outlets/new">
            <Button>Add Outlet</Button>
          </Link>
        </PermissionGate>
      </div>

      {!isLoading && !isError && !hasActive ? (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          No active outlet. Shipping providers cannot compute rates and the app will fail to boot if a provider is
          enabled. Activate an outlet below.
        </div>
      ) : null}

      <Card>
        <CardTitle>Outlets</CardTitle>
        <div className="mt-4 space-y-3">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading outlets…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load outlets. Please reauthenticate.</p>
          ) : data?.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No outlets configured yet.</p>
          ) : (
            data?.map((outlet) => (
              <div
                key={outlet.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-100 p-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-800">{outlet.name}</p>
                    {outlet.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="brand">Inactive</Badge>}
                  </div>
                  <p className="text-sm text-gray-500">
                    {[outlet.addressDetail, regionLine(outlet)].filter(Boolean).join(' · ')}
                  </p>
                  <p className="text-xs text-gray-400">
                    Postal {outlet.postalCode ?? '—'} · Lat {String(outlet.latitude ?? '—')} · Lng{' '}
                    {String(outlet.longitude ?? '—')}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!outlet.isActive ? (
                    <PermissionGate permissions={ROUTE_PERMISSIONS.outletActivate}>
                      <Button onClick={() => handleActivate(outlet.id)}>Activate</Button>
                    </PermissionGate>
                  ) : null}
                  <PermissionGate permissions={ROUTE_PERMISSIONS.outletUpdate}>
                    <Link href={`/outlets/${outlet.id}`}>
                      <Button className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50">Edit</Button>
                    </Link>
                  </PermissionGate>
                  {!outlet.isActive ? (
                    <PermissionGate permissions={ROUTE_PERMISSIONS.outletDelete}>
                      <Button
                        className="bg-white text-red-600 ring-1 ring-gray-200 hover:bg-gray-50"
                        onClick={() => handleDelete(outlet.id)}
                      >
                        Delete
                      </Button>
                    </PermissionGate>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
