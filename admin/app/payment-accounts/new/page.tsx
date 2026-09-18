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
        <h2 className="text-xl font-semibold text-gray-900">Tambah Rekening Pembayaran</h2>
        <p className="mt-1 text-sm text-gray-500">Rekening baru dibuat dalam status nonaktif. Aktifkan salah satu untuk dipakai di notifikasi checkout.</p>
      </div>
      <PaymentAccountForm
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Rekening Pembayaran'),
            action: () => create.mutateAsync(values),
          });
        }}
        submitLabel={create.isPending ? 'Membuat...' : 'Buat Rekening'}
        isSubmitting={create.isPending}
      />
    </AdminShell>
  );
}
