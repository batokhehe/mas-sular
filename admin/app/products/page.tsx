'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { productStatusLabel } from '@/lib/status-labels';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { useAdminPermissions } from '@/lib/auth';
import { hasAllPermissions } from '@/lib/permissions';
import { showError, showSuccess } from '@/lib/admin-alert';
import { fetchAdminProducts, reorderAdminProducts, AdminProduct } from '@/lib/admin';
import {
  applyDrag,
  DEFAULT_PRODUCT_SORT,
  isReorderable,
  moveProduct,
  PRODUCT_SORT_OPTIONS,
  PRODUCT_STATUS_FILTER_OPTIONS,
  REORDER_DISABLED_HINT,
  reorderPayload,
  sameOrder,
  sortProducts,
  type ProductSortValue,
  type ProductStatusFilter,
} from '@/lib/products/product-sequence';

export default function ProductsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ProductStatusFilter>('ALL');
  const [sort, setSort] = useState<ProductSortValue>(DEFAULT_PRODUCT_SORT);
  // The order being dragged, before the server confirms it. Null = show the server's order.
  const [draft, setDraft] = useState<AdminProduct[] | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-products'],
    queryFn: fetchAdminProducts,
    retry: false,
  });

  // The whole list is shown (no pagination): the catalogue order is only meaningful
  // when every product is on screen at once.
  const products = useMemo(() => {
    if (!data) return [];

    const matching = data.filter((product) => {
      // SKU is internal and never shown (P2 #5), so it is not searchable either.
      const matchesSearch = [product.name, product.categoryId].some((field) =>
        field.toLowerCase().includes(search.toLowerCase()),
      );
      const matchesStatus = statusFilter === 'ALL' || product.status === statusFilter;
      return matchesSearch && matchesStatus;
    });

    return sortProducts(matching, sort);
  }, [data, search, statusFilter, sort]);

  const permissions = useAdminPermissions();
  const mayReorder = hasAllPermissions(permissions, ROUTE_PERMISSIONS.productUpdate);
  // Dragging only means something on the complete list in canonical order.
  const reorderable = isReorderable({ sort, search, statusFilter });
  const dragEnabled = mayReorder && reorderable;
  const rows = draft ?? products;

  const reorderMutation = useMutation({
    mutationFn: reorderAdminProducts,
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['admin-products'] });
      showSuccess('Urutan produk berhasil disimpan');
    },
    onError: (error) => {
      setDraft(null); // the stored order is the truth; drop the local attempt
      void showError(error);
    },
  });

  /** Persist a new local order. Never called when dragging is disabled. */
  const save = (next: AdminProduct[]) => {
    if (!dragEnabled || sameOrder(rows, next)) return;
    setDraft(next);
    reorderMutation.mutate(reorderPayload(next).items);
  };

  const onDrop = (to: number) => {
    if (dragIndex === null) return;
    save(applyDrag(rows, dragIndex, to));
    setDragIndex(null);
  };

  const resetDraft = () => setDraft(null);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.products}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Manajemen Produk</h2>
          <p className="mt-1 text-sm text-gray-500">Katalog, stok, harga, dan visibilitas produk.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.productCreate}>
          <Link href="/products/new">
            <Button type="button">Tambah Produk</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                resetDraft();
              }}
              placeholder="Cari produk berdasarkan nama atau kategori"
              className="h-11 rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as ProductStatusFilter);
                resetDraft();
              }}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              {PRODUCT_STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option === 'ALL' ? 'Semua' : productStatusLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Urutkan</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as ProductSortValue);
                resetDraft();
              }}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              {PRODUCT_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <CardTitle>Produk</CardTitle>
        {mayReorder ? (
          <p className="mt-2 text-xs text-gray-500">
            {dragEnabled
              ? 'Tarik ikon urutan untuk mengatur urutan produk di katalog dan halaman pelanggan.'
              : REORDER_DISABLED_HINT}
          </p>
        ) : null}
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Memuat produk…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Gagal memuat produk. Silakan masuk ulang.</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">Tidak ada produk yang cocok dengan filter.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  {mayReorder ? <th className="w-10 py-3 font-medium">Urutan</th> : null}
                  <th className="py-3 font-medium">Nama</th>
                  <th className="py-3 font-medium">Kategori</th>
                  <th className="py-3 font-medium">Stok</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((product: AdminProduct, index: number) => (
                  <tr
                    key={product.id}
                    draggable={dragEnabled}
                    onDragStart={() => dragEnabled && setDragIndex(index)}
                    onDragOver={(event) => {
                      if (dragEnabled && dragIndex !== null) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      if (!dragEnabled) return;
                      event.preventDefault();
                      onDrop(index);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className={`border-b border-gray-50 last:border-0 ${dragIndex === index ? 'bg-gray-50' : ''}`}
                  >
                    {mayReorder ? (
                      <td className="py-4">
                        <button
                          type="button"
                          disabled={!dragEnabled}
                          aria-label={`Ubah urutan ${product.name}`}
                          title={dragEnabled ? 'Tarik untuk mengatur urutan' : REORDER_DISABLED_HINT}
                          onKeyDown={(event) => {
                            if (!dragEnabled) return;
                            if (event.key === 'ArrowUp') {
                              event.preventDefault();
                              save(moveProduct(rows, index, -1));
                            }
                            if (event.key === 'ArrowDown') {
                              event.preventDefault();
                              save(moveProduct(rows, index, 1));
                            }
                          }}
                          className={`rounded-lg p-1 text-gray-400 ${
                            dragEnabled ? 'cursor-grab hover:bg-gray-100 hover:text-gray-600' : 'cursor-not-allowed opacity-40'
                          }`}
                        >
                          <GripVertical className="size-4" />
                        </button>
                      </td>
                    ) : null}
                    <td className="py-4 text-gray-600">
                      {product.name}
                      {product.isPromoSpecial ? (
                        <Badge tone="brand" className="ml-2">
                          Promo Spesial
                        </Badge>
                      ) : null}
                      {product.isTrialPack ? (
                        <Badge tone="brand" className="ml-2">
                          Trial Pack
                        </Badge>
                      ) : null}
                    </td>
                    <td className="py-4 text-gray-500">{product.categoryId}</td>
                    <td className="py-4 text-gray-500">{product.stock}</td>
                    <td className="py-4">
                      <Badge tone={product.status === 'ACTIVE' ? 'success' : 'neutral'}>{productStatusLabel(product.status)}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/products/${product.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        Lihat
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!isLoading && !isError && rows.length > 0 ? (
          <p className="mt-4 text-sm text-gray-600">
            {reorderMutation.isPending ? 'Menyimpan urutan…' : `Menampilkan ${rows.length} produk`}
          </p>
        ) : null}
      </Card>
    </AdminShell>
  );
}
