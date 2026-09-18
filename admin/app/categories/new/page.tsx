'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { CategoryForm, CategoryFormValues } from '@/app/categories/components/category-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { createAdminCategory } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewCategoryPage() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const createCategory = useMutation({
    mutationFn: (input: CategoryFormValues) => createAdminCategory(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
      router.push('/categories');
    },
  });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.categoryCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Tambah Kategori</h2>
        <p className="mt-1 text-sm text-gray-500">Buat kategori katalog untuk produk dan filter storefront.</p>
      </div>
      <CategoryForm
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Kategori'),
            action: () => createCategory.mutateAsync(values),
          });
        }}
        submitLabel={createCategory.isPending ? 'Membuat...' : 'Buat Kategori'}
        isSubmitting={createCategory.isPending}
      />
    </AdminShell>
  );
}
