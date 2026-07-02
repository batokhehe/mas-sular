'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminPermissions, createAdminRole } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';
import { RoleForm } from '../components/role-form';

export default function NewRolePage() {
  const router = useRouter();
  const { data: permissions, isLoading, isError } = useQuery({
    queryKey: ['admin-permissions'],
    queryFn: fetchAdminPermissions,
    retry: false,
  });

  const createRole = useMutation({
    mutationFn: createAdminRole,
    onSuccess: () => {
      router.push('/roles');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roleCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Create Role</h2>
        <p className="mt-1 text-sm text-gray-500">Define a new role and assign permission scopes.</p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading permissions…</p>
      ) : isError || !permissions ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load permissions. Please try again later.</p>
        </div>
      ) : (
        <RoleForm
          permissions={permissions}
          submitLabel="Create Role"
          isSubmitting={createRole.isPending}
          onSubmit={async (values) => {
            await runWithFeedback({
              loading: ADMIN_LOADING_MESSAGES.create,
              success: ADMIN_SUCCESS_MESSAGES.created('Role'),
              action: () => createRole.mutateAsync({ name: values.name, description: values.description, permissionIds: values.permissionIds }),
            });
          }}
        />
      )}
    </AdminShell>
  );
}
