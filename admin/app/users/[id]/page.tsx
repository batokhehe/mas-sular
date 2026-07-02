'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminRoles, fetchAdminUser, updateAdminUser, AdminRole, AdminUserDetail } from '@/lib/admin';
import { formatAdminAddressLine } from '@/lib/format-address';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmStatusChange, confirmUpdate, runWithFeedback } from '@/lib/admin-alert';

export default function UserDetailPage() {
  const params = useParams();
  const userId = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-user', userId],
    queryFn: () => (userId ? fetchAdminUser(userId) : Promise.reject(new Error('Missing user id'))),
    enabled: Boolean(userId),
    retry: false,
  });

  const rolesQuery = useQuery({
    queryKey: ['admin-roles'],
    queryFn: fetchAdminRoles,
    retry: false,
  });

  const [isActive, setIsActive] = useState(false);
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  useEffect(() => {
    if (data) {
      setIsActive(data.isActive);
      setSelectedRoleIds(data.roles.map((assignment) => assignment.role.id));
    }
  }, [data]);

  const updateUser = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { isActive: boolean; roleIds: string[] } }) => updateAdminUser(id, input),
    onSuccess: () => {
      if (userId) {
        queryClient.invalidateQueries({ queryKey: ['admin-user', userId] });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });

  const toggleRoleSelection = (roleId: string) => {
    setSelectedRoleIds((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
    );
  };

  const handleSave = async () => {
    if (!userId) return;
    // Activate/Deactivate confirm shows the status transition; pure role edits use a generic save confirm.
    const wasActive = data?.isActive;
    const activeChanged = wasActive !== undefined && wasActive !== isActive;
    await runWithFeedback({
      confirm: () =>
        activeChanged
          ? confirmStatusChange(wasActive ? 'Active' : 'Disabled', isActive ? 'Active' : 'Disabled', {
              title: isActive ? 'Activate User?' : 'Deactivate User?',
            })
          : confirmUpdate({ title: 'Save changes?' }),
      loading: ADMIN_LOADING_MESSAGES.update,
      success: ADMIN_SUCCESS_MESSAGES.updated,
      action: () => updateUser.mutateAsync({ id: userId, input: { isActive, roleIds: selectedRoleIds } }),
    });
  };

  if (isLoading || rolesQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.userUpdate}>
        <p className="text-sm text-gray-500">Loading user details…</p>
      </AdminShell>
    );
  }

  if (isError || !data || rolesQuery.isError || !rolesQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.userUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load user details. Please try again later.</p>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.userUpdate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">User Details</h2>
        <p className="mt-1 text-sm text-gray-500">Inspect customer profile, order history, and role membership.</p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Card>
          <CardTitle>Profile</CardTitle>
          <div className="mt-4 space-y-4 text-sm text-gray-700">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-gray-400">Name</p>
                <p className="mt-2 font-medium text-gray-900">{data.name}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Email</p>
                <p className="mt-2 font-medium text-gray-900">{data.email}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Phone</p>
                <p className="mt-2 font-medium text-gray-900">{data.phone ?? '-'}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-gray-400">Status</p>
                <Badge tone={isActive ? 'success' : 'danger'} className="mt-2">
                  {isActive ? 'Active' : 'Disabled'}
                </Badge>
              </div>
            </div>
          </div>

          <div className="mt-8">
            <p className="text-xs uppercase tracking-wide text-gray-500">Roles</p>
            <div className="mt-3 rounded-2xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
              {selectedRoleIds.length > 0 ? (
                <ul className="space-y-2">
                  {selectedRoleIds.map((roleId) => {
                    const role = rolesQuery.data?.find((item) => item.id === roleId);
                    return (
                      <li key={roleId} className="font-medium text-gray-900">
                        {role?.name ?? roleId}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No roles assigned.</p>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardTitle>Admin Actions</CardTitle>
          <div className="mt-4 space-y-4 text-sm text-gray-700">
            <div>
              <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                <span className="text-sm text-gray-700">Active user account</span>
              </label>
            </div>

            <div>
              <p className="text-xs uppercase text-gray-400">Assign Roles</p>
              <div className="mt-3 grid gap-2">
                {rolesQuery.data.map((role: AdminRole) => (
                  <label key={role.id} className="inline-flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={selectedRoleIds.includes(role.id)}
                      onChange={() => toggleRoleSelection(role.id)}
                      className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                    />
                    <span>{role.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <Button onClick={handleSave} disabled={updateUser.isPending} className="w-full">
              {updateUser.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </Card>
      </div>

      <Card className="mt-6">
        <CardTitle>Saved Addresses</CardTitle>
        <div className="mt-4 space-y-3">
          {data.addresses.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">This user has no saved addresses.</p>
          ) : (
            data.addresses.map((address) => (
              <div key={address.id} className="rounded-2xl border border-gray-200 p-4">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-900">{address.label}</p>
                  <span className="text-sm text-gray-500">
                    {address.recipientName} • {address.phone}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-500">{formatAdminAddressLine(address)}</p>
                {address.notes ? <p className="mt-1 text-xs text-gray-400">Notes: {address.notes}</p> : null}
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <CardTitle>Order History</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {data.orders.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">This user has no orders yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Order</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Total</th>
                  <th className="py-3 font-medium">Placed</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((order) => (
                  <tr key={order.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{order.orderNumber}</td>
                    <td className="py-4 text-gray-500">{order.status}</td>
                    <td className="py-4 text-gray-500">Rp {order.totalPrice.toLocaleString('id-ID')}</td>
                    <td className="py-4 text-gray-500">{new Date(order.createdAt).toLocaleDateString('id-ID')}</td>
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
