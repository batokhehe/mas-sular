'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PromoForm, PromoFormValues } from '@/app/promos/components/promo-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createAdminPromo } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewPromoPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createPromo = useMutation({
    mutationFn: (input: PromoFormValues) => createAdminPromo(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-promos'] });
      router.push('/promos');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.promoCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">New Voucher</h2>
        <p className="mt-1 text-sm text-gray-500">Create a new promo code for campaigns and discounts.</p>
      </div>
      <PromoForm
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Voucher'),
            action: () => createPromo.mutateAsync(values),
          });
        }}
        submitLabel={createPromo.isPending ? 'Creating...' : 'Create Voucher'}
        isSubmitting={createPromo.isPending}
      />
    </AdminShell>
  );
}
