'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { CoverageForm } from '@/app/delivery-coverage/components/coverage-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createDeliveryCoverage, DeliveryCoverageInput } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewDeliveryCoveragePage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (input: DeliveryCoverageInput) => createDeliveryCoverage(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-delivery-coverage'] }),
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.deliveryCoverageCreate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Add Delivery Coverage</h2>
          <p className="mt-1 text-sm text-gray-500">Define a coverage rule for a province, city, district, or village.</p>
        </div>
        <Link href="/delivery-coverage" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to coverage
        </Link>
      </div>
      <CoverageForm
        submitLabel="Create Coverage"
        isSubmitting={createMutation.isPending}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Delivery Coverage'),
            action: () => createMutation.mutateAsync(values),
          });
          router.push('/delivery-coverage');
        }}
      />
    </AdminShell>
  );
}
