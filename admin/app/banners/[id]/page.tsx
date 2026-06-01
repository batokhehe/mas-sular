'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PermissionGate } from '@/components/auth/permission-gate';
import { AdminShell } from '@/components/layout/admin-shell';
import { BannerForm, BannerFormValues } from '@/app/banners/components/banner-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { deleteAdminBanner, fetchAdminBanner, updateAdminBanner } from '@/lib/admin';

export default function BannerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const bannerId = typeof params?.id === 'string' ? params.id : undefined;

  const bannerQuery = useQuery({
    queryKey: ['admin-banner', bannerId],
    queryFn: () => (bannerId ? fetchAdminBanner(bannerId) : Promise.reject(new Error('Missing banner id'))),
    enabled: Boolean(bannerId),
    retry: false,
  });

  const updateBanner = useMutation({
    mutationFn: ({ id, input }: { id: string; input: BannerFormValues }) => updateAdminBanner(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-banners'] });
      if (bannerId) {
        queryClient.invalidateQueries({ queryKey: ['admin-banner', bannerId] });
      }
    },
  });

  const deleteBanner = useMutation({
    mutationFn: () => {
      if (!bannerId) throw new Error('Missing banner id');
      return deleteAdminBanner(bannerId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-banners'] });
      router.push('/banners');
    },
  });

  if (bannerQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.bannerUpdate}>
        <p className="p-6 text-sm text-gray-500">Loading banner details...</p>
      </AdminShell>
    );
  }

  if (bannerQuery.isError || !bannerQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.bannerUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load banner details. Please try again later.</p>
          <Link href="/banners" className="font-medium text-[#465fff] underline">
            Back to banners
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.bannerUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Banner</h2>
          <p className="mt-1 text-sm text-gray-500">Update banner copy, schedule, and placement.</p>
        </div>
        <Link href="/banners" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to banners
        </Link>
      </div>
      <PermissionGate permissions={ROUTE_PERMISSIONS.bannerUpdate}>
        <BannerForm
          initialValues={bannerQuery.data}
          onSubmit={async (values) => {
            if (!bannerId) return;
            await updateBanner.mutateAsync({ id: bannerId, input: values });
          }}
          onDelete={async () => {
            await deleteBanner.mutateAsync();
          }}
          submitLabel={updateBanner.isPending ? 'Saving...' : 'Save Banner'}
          isSubmitting={updateBanner.isPending}
          isDeleting={deleteBanner.isPending}
        />
      </PermissionGate>
    </AdminShell>
  );
}
