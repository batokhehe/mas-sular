'use client';

import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ProductForm, ProductFormValues } from '@/app/products/components/product-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminCategories, createAdminProduct } from '@/lib/admin';

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
        <p className="p-6 text-sm text-gray-500">Loading categories...</p>
      </AdminShell>
    );
  }

  if (isError || !categories) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productCreate}>
        <p className="p-6 text-sm text-red-600">Unable to load categories. Please reauthenticate.</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productCreate}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Add Product</h2>
        <p className="mt-1 text-sm text-gray-500">Create a new product for the catalog.</p>
      </div>
      <ProductForm
        categories={categories}
        onSubmit={async (values) => {
          await createProduct.mutateAsync(values);
        }}
        submitLabel={createProduct.isPending ? 'Creating...' : 'Create Product'}
        isSubmitting={createProduct.isPending}
      />
    </AdminShell>
  );
}
