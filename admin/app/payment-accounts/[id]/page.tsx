'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PaymentAccountForm, PaymentAccountFormValues } from '@/app/payment-accounts/components/payment-account-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { deletePaymentAccount, fetchPaymentAccount, updatePaymentAccount } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmDelete, runWithFeedback } from '@/lib/admin-alert';

export default function EditPaymentAccountPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = typeof params?.id === 'string' ? params.id : undefined;

  const query = useQuery({
    queryKey: ['admin-payment-account', id],
    queryFn: () => (id ? fetchPaymentAccount(id) : Promise.reject(new Error('Missing id'))),
    enabled: Boolean(id),
    retry: false,
  });

  const update = useMutation({
    mutationFn: (input: Partial<PaymentAccountFormValues>) => updatePaymentAccount(id!, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-payment-accounts'] });
      if (id) queryClient.invalidateQueries({ queryKey: ['admin-payment-account', id] });
    },
  });

  const remove = useMutation({
    mutationFn: () => deletePaymentAccount(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-payment-accounts'] });
      router.push('/payment-accounts');
    },
  });

  if (query.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.paymentAccountUpdate}>
        <p className="p-6 text-sm text-gray-500">Loading payment account...</p>
      </AdminShell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.paymentAccountUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load payment account.</p>
          <Link href="/payment-accounts" className="font-medium text-[#465fff] underline">
            Back to payment accounts
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.paymentAccountUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-gray-900">Edit Payment Account</h2>
        <Link href="/payment-accounts" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to payment accounts
        </Link>
      </div>
      <PaymentAccountForm
        initialValues={query.data}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => update.mutateAsync(values),
          });
        }}
        // The active account cannot be deleted — hide the delete action for it.
        onDelete={
          query.data.isActive
            ? undefined
            : async () => {
                await runWithFeedback({
                  confirm: () => confirmDelete('Payment Account'),
                  loading: ADMIN_LOADING_MESSAGES.delete,
                  success: ADMIN_SUCCESS_MESSAGES.deleted('Payment Account'),
                  action: () => remove.mutateAsync(),
                });
              }
        }
        submitLabel={update.isPending ? 'Saving...' : 'Save Account'}
        isSubmitting={update.isPending}
        isDeleting={remove.isPending}
      />
    </AdminShell>
  );
}
