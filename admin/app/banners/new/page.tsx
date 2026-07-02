'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { BannerForm, BannerFormValues } from '@/app/banners/components/banner-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createAdminBanner } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewBannerPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createBanner = useMutation({
    mutationFn: (input: BannerFormValues) => createAdminBanner(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-banners'] });
      router.push('/banners');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.bannerCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Add Banner</h2>
        <p className="mt-1 text-sm text-gray-500">Create a new CMS banner placement.</p>
      </div>
      <BannerForm
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Banner'),
            action: () => createBanner.mutateAsync(values),
          });
        }}
        submitLabel={createBanner.isPending ? 'Creating...' : 'Create Banner'}
        isSubmitting={createBanner.isPending}
      />
    </AdminShell>
  );
}
