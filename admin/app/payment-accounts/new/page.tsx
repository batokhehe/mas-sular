'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PaymentAccountForm, PaymentAccountFormValues } from '@/app/payment-accounts/components/payment-account-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createPaymentAccount } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewPaymentAccountPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: (input: PaymentAccountFormValues) => createPaymentAccount(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-payment-accounts'] });
      router.push('/payment-accounts');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.paymentAccountCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Add Payment Account</h2>
        <p className="mt-1 text-sm text-gray-500">New accounts are created inactive. Activate one to use it in checkout notifications.</p>
      </div>
      <PaymentAccountForm
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Payment Account'),
            action: () => create.mutateAsync(values),
          });
        }}
        submitLabel={create.isPending ? 'Creating...' : 'Create Account'}
        isSubmitting={create.isPending}
      />
    </AdminShell>
  );
}
