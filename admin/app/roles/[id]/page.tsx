'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminRole, AdminRole } from '@/lib/admin';

export default function RoleDetailPage() {
  const params = useParams();
  const roleId = typeof params?.id === 'string' ? params.id : undefined;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-role', roleId],
    queryFn: () => (roleId ? fetchAdminRole(roleId) : Promise.reject(new Error('Missing role id'))),
    enabled: Boolean(roleId),
    retry: false,
  });

  if (isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roles}>
        <p className="text-sm text-gray-500">Loading role details…</p>
      </AdminShell>
    );
  }

  if (isError || !data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roles}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load role details. Please try again later.</p>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roles}>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Role Details</h2>
          <p className="mt-1 text-sm text-gray-500">Review role permissions and approval scope.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.roleUpdate}>
          <Link href={`/roles/${roleId}/edit`}>
            <Button>Edit Role</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <CardTitle>{data.name}</CardTitle>
        <div className="mt-4 space-y-4 text-sm text-gray-700">
          <div>
            <p className="text-xs uppercase text-gray-400">Description</p>
            <p className="mt-2 text-gray-900">{data.description ?? 'No description available.'}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-gray-400">Permissions</p>
            {data.permissions.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {data.permissions.map((assignment) => (
                  <Badge key={assignment.permission.id} tone="brand">
                    {assignment.permission.subject}:{assignment.permission.action}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-gray-500">No permissions assigned.</p>
            )}
          </div>
        </div>
      </Card>
    </AdminShell>
  );
}
