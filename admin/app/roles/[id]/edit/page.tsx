'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminRole, fetchAdminPermissions, updateAdminRole } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';
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

  // The optimistic-concurrency token is captured ONCE, from the GET that seeded the
  // form (C7b). Reading roleQuery.data at submit time would pick up a refetch - on
  // window focus, say - and hand the server a fresh timestamp that always matches,
  // which is exactly the silent-overwrite this protects against.
  const loadedUpdatedAt = useRef<string | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (roleQuery.data && loadedUpdatedAt.current === null) {
      loadedUpdatedAt.current = roleQuery.data.updatedAt;
    }
  }, [roleQuery.data]);

  const updateRole = useMutation({
    mutationFn: (input: { name: string; description?: string; permissionIds: string[] }) =>
      updateAdminRole(roleId ?? '', { ...input, expectedUpdatedAt: loadedUpdatedAt.current ?? '' }),
    onSuccess: () => {
      setConflict(false);
      router.push('/roles');
    },
    onError: (error: unknown) => {
      // 409 means another administrator saved first. Surface it and stop: no silent
      // retry, no refetch over the form. The edits stay on screen so they can be
      // reapplied deliberately after a manual reload.
      setConflict(typeof error === 'object' && error !== null && (error as { status?: number }).status === 409);
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

      {conflict ? (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">Role was modified by another administrator.</p>
          <p className="mt-1">
            Your changes below have not been saved. Reload this page to see the current permissions,
            then reapply your edits.
          </p>
        </div>
      ) : null}

      <RoleForm
        permissions={permissionsQuery.data}
        initialValues={roleQuery.data}
        submitLabel="Update Role"
        isSubmitting={updateRole.isPending}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => updateRole.mutateAsync({ name: values.name, description: values.description, permissionIds: values.permissionIds }),
          });
        }}
      />
    </AdminShell>
  );
}
