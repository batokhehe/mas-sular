'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminRole, fetchAdminPermissions, updateAdminRole } from '@/lib/admin';
import { RoleForm } from '../../components/role-form';

export default function EditRolePage() {
  const params = useParams();
  const router = useRouter();
  const roleId = typeof params?.id === 'string' ? params.id : undefined;

  const roleQuery = useQuery({
    queryKey: ['admin-role', roleId],
    queryFn: () => (roleId ? fetchAdminRole(roleId) : Promise.reject(new Error('Missing role id'))),
    enabled: Boolean(roleId),
    retry: false,
  });

  const permissionsQuery = useQuery({
    queryKey: ['admin-permissions'],
    queryFn: fetchAdminPermissions,
    retry: false,
  });

  const updateRole = useMutation({
    mutationFn: (input: { name: string; description?: string; permissionIds: string[] }) =>
      updateAdminRole(roleId ?? '', input),
    onSuccess: () => {
      router.push('/roles');
    },
  });

  if (roleQuery.isLoading || permissionsQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roleUpdate}>
        <p className="text-sm text-gray-500">Loading role information…</p>
      </AdminShell>
    );
  }

  if (roleQuery.isError || permissionsQuery.isError || !roleQuery.data || !permissionsQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roleUpdate}>
        <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load role data. Please try again later.</p>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.roleUpdate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Edit Role</h2>
        <p className="mt-1 text-sm text-gray-500">Update role name, description, and permissions.</p>
      </div>

      <RoleForm
        permissions={permissionsQuery.data}
        initialValues={roleQuery.data}
        submitLabel="Update Role"
        isSubmitting={updateRole.isPending}
        onSubmit={async (values) => {
          await updateRole.mutateAsync({ name: values.name, description: values.description, permissionIds: values.permissionIds });
        }}
      />
    </AdminShell>
  );
}
