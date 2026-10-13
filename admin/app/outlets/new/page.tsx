'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { OutletForm } from '@/app/outlets/components/outlet-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createOutlet, OutletInput } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewOutletPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (input: OutletInput) => createOutlet(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-outlets'] }),
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.outletCreate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Tambah Outlet</h2>
          <p className="mt-1 text-sm text-gray-500">Outlet baru dibuat nonaktif — aktifkan salah satu untuk dipakai sebagai asal pengiriman.</p>
        </div>
        <Link href="/outlets" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Kembali ke outlet
        </Link>
      </div>
      <OutletForm
        submitLabel="Buat Outlet"
        isSubmitting={createMutation.isPending}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Outlet'),
            action: () => createMutation.mutateAsync(values),
          });
          router.push('/outlets');
        }}
      />
    </AdminShell>
  );
}
