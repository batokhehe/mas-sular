'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { AdminCategory, fetchAdminCategories } from '@/lib/admin';

export default function CategoriesPage() {
  const [search, setSearch] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-categories'],
    queryFn: fetchAdminCategories,
    retry: false,
  });

  const categories = useMemo(() => {
    if (!data) return [];
    return data.filter((category) =>
      [category.name, category.slug, category.icon ?? ''].some((field) =>
        field.toLowerCase().includes(search.toLowerCase()),
      ),
    );
  }, [data, search]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.categories}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Category Management</h2>
          <p className="mt-1 text-sm text-gray-500">Manage catalog groupings used by product forms and customer menus.</p>
        </div>
        <PermissionGate permissions={ROUTE_PERMISSIONS.categoryCreate}>
          <Link href="/categories/new">
            <Button type="button">Add Category</Button>
          </Link>
        </PermissionGate>
      </div>

      <Card>
        <div className="mb-4">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search categories by name, slug, or icon"
            className="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm outline-none focus:border-[#465fff] focus:bg-white md:max-w-md"
          />
        </div>

        <CardTitle>Categories</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-gray-500">Loading categories...</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-600">Unable to load categories. Please reauthenticate.</p>
          ) : categories.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No categories match your filters.</p>
          ) : (
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-3 font-medium">Name</th>
                  <th className="py-3 font-medium">Slug</th>
                  <th className="py-3 font-medium">Icon</th>
                  <th className="py-3 font-medium">Sort</th>
                  <th className="py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category: AdminCategory) => (
                  <tr key={category.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-4 font-medium text-gray-800">{category.name}</td>
                    <td className="py-4 text-gray-500">{category.slug}</td>
                    <td className="py-4 text-gray-500">{category.icon || '-'}</td>
                    <td className="py-4 text-gray-500">{category.sortOrder}</td>
                    <td className="py-4">
                      <Link href={`/categories/${category.id}`} className="text-sm font-medium text-[#465fff] hover:text-indigo-700">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Card>
    </AdminShell>
  );
}
