'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { CoverageForm } from '@/app/delivery-coverage/components/coverage-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { DeliveryCoverageInput, fetchDeliveryCoverage, updateDeliveryCoverage } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function EditDeliveryCoveragePage() {
  const router = useRouter();
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-delivery-coverage', id],
    queryFn: () => (id ? fetchDeliveryCoverage(id) : Promise.reject(new Error('Missing id'))),
    enabled: Boolean(id),
    retry: false,
  });

  const updateMutation = useMutation({
    mutationFn: (input: DeliveryCoverageInput) => {
      if (!id) throw new Error('Missing id');
      return updateDeliveryCoverage(id, input);
    },
    onSuccess: () => {
      if (id) queryClient.invalidateQueries({ queryKey: ['admin-delivery-coverage', id] });
      queryClient.invalidateQueries({ queryKey: ['admin-delivery-coverage'] });
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.deliveryCoverageUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Delivery Coverage</h2>
          <p className="mt-1 text-sm text-gray-500">Update the coverage rule for this area.</p>
        </div>
        <Link href="/delivery-coverage" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to coverage
        </Link>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading coverage…</p>
      ) : isError || !data ? (
        <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          Unable to load this coverage rule.
        </div>
      ) : (
        <CoverageForm
          initialValues={data}
          submitLabel="Save Changes"
          isSubmitting={updateMutation.isPending}
          onSubmit={async (values) => {
            await runWithFeedback({
              loading: ADMIN_LOADING_MESSAGES.update,
              success: ADMIN_SUCCESS_MESSAGES.updated,
              action: () => updateMutation.mutateAsync(values),
            });
            router.push('/delivery-coverage');
          }}
        />
      )}
    </AdminShell>
  );
}
