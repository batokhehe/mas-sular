'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchAdminProducts, AdminProduct } from '@/lib/admin';

const PAGE_SIZE = 10;
const statusOptions = ['ALL', 'ACTIVE', 'DRAFT', 'ARCHIVED'] as const;
const sortOptions = [
  { label: 'Newest', value: 'createdAt' },
  { label: 'Name A → Z', value: 'nameAsc' },
  { label: 'Stock Low → High', value: 'stockAsc' },
  { label: 'Stock High → Low', value: 'stockDesc' },
];

export default function ProductsPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<typeof statusOptions[number]>('ALL');
  const [sort, setSort] = useState(sortOptions[0].value);
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-products'],
    queryFn: fetchAdminProducts,
    retry: false,
  });

  const products = useMemo(() => {
    if (!data) return [];

    return data
      .filter((product) => {
        const matchesSearch = [product.sku, product.name, product.categoryId].some((field) =>
          field.toLowerCase().includes(search.toLowerCase()),
        );
        const matchesStatus = statusFilter === 'ALL' || product.status === statusFilter;
        return matchesSearch && matchesStatus;
      })
      .sort((a, b) => {
        if (sort === 'nameAsc') return a.name.localeCompare(b.name);
        if (sort === 'stockAsc') return a.stock - b.stock;
        if (sort === 'stockDesc') return b.stock - a.stock;
        return b.createdAt.localeCompare(a.createdAt);
      });
  }, [data, search, statusFilter, sort]);

  const pageCount = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  const pageProducts = products.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.products}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Product Management</h2>
          <p className="mt-1 text-sm text-gray-500">Catalog, stock, pricing, and product visibility.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.productCreate}>
          <Link href="/products/new">
            <Button type="button">Add Product</Button>
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
                setPage(1);
              }}
              placeholder="Search products by SKU, name, or category"
              className="h-11 rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
            <select
              value={statusFilter}
              onChange={(event) => {
                setStatusFilter(event.target.value as typeof statusOptions[number]);
                setPage(1);
              }}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Sort by</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="h-11 rounded-xl border border-gray-200 bg-white px-4 text-sm outline-none focus:border-[#465fff]"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <CardTitle>Products</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading products…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load products. Please reauthenticate.</p>
          ) : pageProducts.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No products match your filters.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">SKU</th>
                  <th className="py-3 font-medium">Name</th>
                  <th className="py-3 font-medium">Category</th>
                  <th className="py-3 font-medium">Stock</th>
                  <th className="py-3 font-medium">Status</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageProducts.map((product: AdminProduct) => (
                  <tr key={product.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{product.sku}</td>
                    <td className="py-4 text-gray-600">{product.name}</td>
                    <td className="py-4 text-gray-500">{product.categoryId}</td>
                    <td className="py-4 text-gray-500">{product.stock}</td>
                    <td className="py-4">
                      <Badge tone={product.status === 'ACTIVE' ? 'success' : 'neutral'}>{product.status}</Badge>
                    </td>
                    <td className="py-4">
                      <Link href={`/products/${product.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!isLoading && !isError && products.length > PAGE_SIZE && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-600">
            <p>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, products.length)} of {products.length} products
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" className="bg-white text-gray-700 hover:bg-gray-50" onClick={() => setPage(Math.max(1, page - 1))}>
                Previous
              </Button>
              <Button type="button" className="bg-white text-gray-700 hover:bg-gray-50" onClick={() => setPage(Math.min(pageCount, page + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </AdminShell>
  );
}
