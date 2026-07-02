'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PromoForm, PromoFormValues } from '@/app/promos/components/promo-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminPromo, updateAdminPromo, deleteAdminPromo } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmDelete, runWithFeedback } from '@/lib/admin-alert';

export default function PromoDetailPage() {
  const router = useRouter();
  const params = useParams();
  const promoId = typeof params?.id === 'string' ? params.id : undefined;
  const queryClient = useQueryClient();

  const promoQuery = useQuery({
    queryKey: ['admin-promo', promoId],
    queryFn: () => (promoId ? fetchAdminPromo(promoId) : Promise.reject(new Error('Missing promo id'))),
    enabled: Boolean(promoId),
    retry: false,
  });

  const updatePromo = useMutation({
    mutationFn: ({ id, input }: { id: string; input: PromoFormValues }) => updateAdminPromo(id, input),
    onSuccess: () => {
      if (promoId) {
        queryClient.invalidateQueries({ queryKey: ['admin-promo', promoId] });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-promos'] });
    },
  });

  const deletePromo = useMutation({
    mutationFn: () => {
      if (!promoId) throw new Error('Missing promo id');
      return deleteAdminPromo(promoId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-promos'] });
      router.push('/promos');
    },
  });

  if (promoQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.promoUpdate}>
        <p className="text-sm text-gray-500">Loading voucher details…</p>
      </AdminShell>
    );
  }

  if (promoQuery.isError || !promoQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.promoUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load voucher details. Please try again later.</p>
          <Link href="/promos" className="font-medium text-[#465fff] underline">Back to vouchers</Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.promoUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Voucher</h2>
          <p className="mt-1 text-sm text-gray-500">Update settings for this promo code.</p>
        </div>
        <Link href="/promos" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">Back to vouchers</Link>
      </div>
      <PromoForm
        initialValues={promoQuery.data}
        onSubmit={async (values) => {
          if (!promoId) return;
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => updatePromo.mutateAsync({ id: promoId, input: values }),
          });
        }}
        onDelete={async () => {
          await runWithFeedback({
            confirm: () => confirmDelete('Voucher'),
            loading: ADMIN_LOADING_MESSAGES.delete,
            success: ADMIN_SUCCESS_MESSAGES.deleted('Voucher'),
            action: () => deletePromo.mutateAsync(),
          });
        }}
        submitLabel={updatePromo.isPending ? 'Save changes' : 'Save voucher'}
        isSubmitting={updatePromo.isPending}
        isDeleting={deletePromo.isPending}
      />
    </AdminShell>
  );
}
