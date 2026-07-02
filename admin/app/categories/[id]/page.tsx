'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { CategoryForm, CategoryFormValues } from '@/app/categories/components/category-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { deleteAdminCategory, fetchAdminCategory, updateAdminCategory } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmDelete, runWithFeedback } from '@/lib/admin-alert';

export default function CategoryDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const categoryId = typeof params?.id === 'string' ? params.id : undefined;

  const categoryQuery = useQuery({
    queryKey: ['admin-category', categoryId],
    queryFn: () => (categoryId ? fetchAdminCategory(categoryId) : Promise.reject(new Error('Missing category id'))),
    enabled: Boolean(categoryId),
    retry: false,
  });

  const updateCategory = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CategoryFormValues }) => updateAdminCategory(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
      if (categoryId) {
        queryClient.invalidateQueries({ queryKey: ['admin-category', categoryId] });
      }
    },
  });

  const deleteCategory = useMutation({
    mutationFn: () => {
      if (!categoryId) throw new Error('Missing category id');
      return deleteAdminCategory(categoryId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-categories'] });
      router.push('/categories');
    },
  });

  if (categoryQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.categoryUpdate}>
        <p className="p-6 text-sm text-gray-500">Loading category details...</p>
      </AdminShell>
    );
  }

  if (categoryQuery.isError || !categoryQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.categoryUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Unable to load category details. Please try again later.</p>
          <Link href="/categories" className="font-medium text-[#465fff] underline">
            Back to categories
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.categoryUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Edit Category</h2>
          <p className="mt-1 text-sm text-gray-500">Update category display details and ordering.</p>
        </div>
        <Link href="/categories" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Back to categories
        </Link>
      </div>
      <CategoryForm
        initialValues={categoryQuery.data}
        onSubmit={async (values) => {
          if (!categoryId) return;
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => updateCategory.mutateAsync({ id: categoryId, input: values }),
          });
        }}
        onDelete={async () => {
          await runWithFeedback({
            confirm: () => confirmDelete('Category'),
            loading: ADMIN_LOADING_MESSAGES.delete,
            success: ADMIN_SUCCESS_MESSAGES.deleted('Category'),
            action: () => deleteCategory.mutateAsync(),
          });
        }}
        submitLabel={updateCategory.isPending ? 'Saving...' : 'Save Category'}
        isSubmitting={updateCategory.isPending}
        isDeleting={deleteCategory.isPending}
      />
    </AdminShell>
  );
}
