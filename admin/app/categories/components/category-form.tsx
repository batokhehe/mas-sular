'use client';

import { useState } from 'react';
import { AdminCategory } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export type CategoryFormValues = {
  name: string;
  slug: string;
  icon?: string;
  sortOrder: number;
};

type CategoryFormProps = {
  initialValues?: Partial<AdminCategory>;
  onSubmit: (values: CategoryFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
};

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function CategoryForm({
  initialValues,
  onSubmit,
  onDelete,
  isSubmitting,
  isDeleting,
  submitLabel,
}: CategoryFormProps) {
  const [values, setValues] = useState<CategoryFormValues>({
    name: initialValues?.name ?? '',
    slug: initialValues?.slug ?? '',
    icon: initialValues?.icon ?? '',
    sortOrder: initialValues?.sortOrder ?? 0,
  });
  const [slugTouched, setSlugTouched] = useState(Boolean(initialValues?.slug));

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({
      ...values,
      icon: values.icon?.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Name</span>
            <input
              value={values.name}
              onChange={(event) => {
                const name = event.target.value;
                setValues((current) => ({
                  ...current,
                  name,
                  slug: slugTouched ? current.slug : toSlug(name),
                }));
              }}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Slug</span>
            <input
              value={values.slug}
              onChange={(event) => {
                setSlugTouched(true);
                setValues((current) => ({ ...current, slug: toSlug(event.target.value) }));
              }}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Icon</span>
            <input
              value={values.icon ?? ''}
              onChange={(event) => setValues((current) => ({ ...current, icon: event.target.value }))}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Sort Order</span>
            <input
              type="number"
              min={0}
              value={values.sortOrder}
              onChange={(event) => setValues((current) => ({ ...current, sortOrder: toNumber(event.target.value) }))}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
          {onDelete ? (
            <Button
              type="button"
              className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50"
              disabled={isDeleting}
              onClick={onDelete}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
