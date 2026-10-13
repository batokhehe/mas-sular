'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { ProductForm, ProductFormValues } from '@/app/products/components/product-form';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminCategories, fetchAdminProduct, updateAdminProduct, deleteAdminProduct } from '@/lib/admin';
import { ADMIN_LOADING_MESSAGES, ADMIN_SUCCESS_MESSAGES, confirmDelete, runWithFeedback } from '@/lib/admin-alert';

export default function ProductDetailPage() {
  const router = useRouter();
  const params = useParams();
  const productId = params?.id as string;
  const queryClient = useQueryClient();

  const categoriesQuery = useQuery({
    queryKey: ['admin-categories'],
    queryFn: fetchAdminCategories,
    retry: false,
  });

  const productQuery = useQuery({
    queryKey: ['admin-product', productId],
    queryFn: () => fetchAdminProduct(productId),
    enabled: Boolean(productId),
    retry: false,
  });

  const updateProduct = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProductFormValues }) => updateAdminProduct(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      queryClient.invalidateQueries({ queryKey: ['admin-product', productId] });
    },
  });

  const deleteProduct = useMutation({
    mutationFn: () => deleteAdminProduct(productId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      router.push('/products');
    },
  });

  if (categoriesQuery.isLoading || productQuery.isLoading) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productUpdate}>
        <p className="p-6 text-sm text-gray-500">Memuat detail produk…</p>
      </AdminShell>
    );
  }

  if (categoriesQuery.isError || productQuery.isError || !categoriesQuery.data || !productQuery.data) {
    return (
      <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productUpdate}>
        <div className="space-y-3 rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-700">
          <p>Gagal memuat detail produk. Silakan masuk ulang atau coba lagi nanti.</p>
          <Link href="/products" className="font-medium text-[#465fff] underline">
            Kembali ke produk
          </Link>
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.productUpdate}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Ubah Produk</h2>
          <p className="mt-1 text-sm text-gray-500">Perbarui detail katalog dan stok produk ini.</p>
        </div>
        <Link href="/products" className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
          Kembali ke produk
        </Link>
      </div>
      <ProductForm
        categories={categoriesQuery.data}
        initialValues={productQuery.data}
        onSubmit={async (values) => {
          await runWithFeedback({
            loading: ADMIN_LOADING_MESSAGES.update,
            success: ADMIN_SUCCESS_MESSAGES.updated,
            action: () => updateProduct.mutateAsync({ id: productId, input: values }),
          });
        }}
        onDelete={async () => {
          await runWithFeedback({
            confirm: () => confirmDelete('Produk'),
            loading: ADMIN_LOADING_MESSAGES.delete,
            success: ADMIN_SUCCESS_MESSAGES.deleted('Produk'),
            action: () => deleteProduct.mutateAsync(),
          });
        }}
        submitLabel={updateProduct.isPending ? 'Menyimpan...' : 'Simpan Perubahan'}
        isSubmitting={updateProduct.isPending}
        isDeleting={deleteProduct.isPending}
      />
    </AdminShell>
  );
}
