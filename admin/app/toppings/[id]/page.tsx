'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ToppingForm } from '@/app/toppings/components/topping-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { useAdminPermissions } from '@/lib/auth';
import { deleteAdminTopping, fetchAdminTopping, updateAdminTopping } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmDelete, runWithFeedback } from '@/lib/admin-alert';
import { hasAllPermissions } from '@/lib/permissions';
import type { ToppingPayload } from '@/lib/toppings/topping-form';

export default function ToppingDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toppingId = typeof params?.id === 'string' ? params.id : undefined;
  const canDelete = hasAllPermissions(useAdminPermissions(), ROUTE_PERMISSIONS.toppingDelete);

  const toppingQuery = useQuery({
    queryKey: ['admin-topping', toppingId],
    queryFn: () => (toppingId ? fetchAdminTopping(toppingId) : Promise.reject(new Error('Missing topping id'))),
    enabled: Boolean(toppingId),
    retry: false,
  });

  const updateTopping = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ToppingPayload }) => updateAdminTopping(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-toppings'] });
      if (toppingId) queryClient.invalidateQueries({ queryKey: ['admin-topping', toppingId] });
    },
  });

  const deleteTopping = useMutation({
    mutationFn: () => {
      if (!toppingId) throw new Error('Missing topping id');
      return deleteAdminTopping(toppingId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-toppings'] });
      router.push('/toppings');
    },
  });

  if (toppingQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.toppingUpdate}>
        <p className="p-6 text-sm text-gray-500">Loading topping details...</p>
      </AdminShell>
    );
  }

  if (toppingQuery.isError || !toppingQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.toppingUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load topping details. Please try again later.</p>
          <Link href="/toppings" className="font-medium text-[#465fff] underline">
            Back to toppings
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.toppingUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Topping</h2>
          <p className="mt-1 text-sm text-gray-500">Existing orders keep the name and price they were placed with.</p>
        </div>
        <Link href="/toppings" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to toppings
        </Link>
      </div>
      <ToppingForm
        initialValues={toppingQuery.data}
        onSubmit={async (payload) => {
          if (!toppingId) return;
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => updateTopping.mutateAsync({ id: toppingId, input: payload }),
          });
        }}
        onDelete={
          canDelete
            ? async () => {
                await runWithFeedback({
                  confirm: () => confirmDelete('Topping'),
                  loading: ADMIN_LOADING_MESSAGES.delete,
                  success: ADMIN_SUCCESS_MESSAGES.deleted('Topping'),
                  action: () => deleteTopping.mutateAsync(),
                });
              }
            : undefined
        }
        submitLabel={updateTopping.isPending ? 'Saving...' : 'Save Topping'}
        isSubmitting={updateTopping.isPending}
        isDeleting={deleteTopping.isPending}
      />
    </AdminShell>
  );
}
