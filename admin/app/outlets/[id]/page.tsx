'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { OutletForm } from '@/app/outlets/components/outlet-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { OutletInput, fetchOutlet, updateOutlet } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function EditOutletPage() {
  const router = useRouter();
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-outlet', id],
    queryFn: () => (id ? fetchOutlet(id) : Promise.reject(new Error('Missing id'))),
    enabled: Boolean(id),
    retry: false,
  });

  const updateMutation = useMutation({
    mutationFn: (input: OutletInput) => {
      if (!id) throw new Error('Missing id');
      return updateOutlet(id, input);
    },
    onSuccess: () => {
      if (id) queryClient.invalidateQueries({ queryKey: ['admin-outlet', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-outlets'] });
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.outletUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Outlet</h2>
          <p className="mt-1 text-sm text-gray-500">Update the outlet used as the shipping origin.</p>
        </div>
        <Link href="/outlets" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to outlets
        </Link>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading outlet…</p>
      ) : isError || !data ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          Unable to load this outlet.
        </div>
      ) : (
        <OutletForm
          initialValues={data}
          submitLabel="Save Changes"
          isSubmitting={updateMutation.isPending}
          onSubmit={async (values) => {
            await runWithFeedback({
              loading: ADMIN_LOADING_MESSAGES.update,
              success: ADMIN_SUCCESS_MESSAGES.updated,
              action: () => updateMutation.mutateAsync(values),
            });
            router.push('/outlets');
          }}
        />
      )}
    </AdminShell>
  );
}
