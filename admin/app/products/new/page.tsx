'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ProductForm, ProductFormValues } from '@/app/products/components/product-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminCategories, createAdminProduct } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

export default function NewProductPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: categories, isLoading, isError } = useQuery({
    queryKey: ['admin-categories'],
    queryFn: fetchAdminCategories,
    retry: false,
  });

  const createProduct = useMutation({
    mutationFn: (input: ProductFormValues) => createAdminProduct(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      router.push('/products');
    },
  });

  if (isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productCreate}>
        <p className="p-6 text-sm text-gray-500">Memuat kategori...</p>
      </AdminShell>
    );
  }

  if (isError || !categories) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productCreate}>
        <p className="p-6 text-sm text-red-600">Gagal memuat kategori. Silakan masuk ulang.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Tambah Produk</h2>
        <p className="mt-1 text-sm text-gray-500">Buat produk baru untuk katalog.</p>
      </div>
      <ProductForm
        categories={categories}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.create,
            success: ADMIN_SUCCESS_MESSAGES.created('Produk'),
            action: () => createProduct.mutateAsync(values),
          });
        }}
        submitLabel={createProduct.isPending ? 'Membuat...' : 'Buat Produk'}
        isSubmitting={createProduct.isPending}
      />
    </AdminShell>
  );
}
