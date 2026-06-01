'use client';

import { useState } from 'react';
import { AdminBanner } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';

export type BannerFormValues = {
  title: string;
  description?: string;
  imageUrl: string;
  href?: string;
  placement: string;
  isActive: boolean;
  startsAt?: string;
  endsAt?: string;
  sortOrder: number;
};

type BannerFormProps = {
  initialValues?: Partial<AdminBanner>;
  onSubmit: (values: BannerFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
  canDelete?: boolean;
};

const placementOptions = ['HOME_HERO', 'HOME_PROMO', 'MENU_TOP', 'CHECKOUT'] as const;

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toDateTimeLocal(value?: string | null) {
  if (!value) return '';
  return value.slice(0, 16);
}

export function BannerForm({
  initialValues,
  onSubmit,
  onDelete,
  isSubmitting,
  isDeleting,
  submitLabel,
  canDelete = true,
}: BannerFormProps) {
  const [values, setValues] = useState<BannerFormValues>({
    title: initialValues?.title ?? '',
    description: initialValues?.description ?? '',
    imageUrl: initialValues?.imageUrl ?? '',
    href: initialValues?.href ?? '',
    placement: initialValues?.placement ?? placementOptions[0],
    isActive: initialValues?.isActive ?? true,
    startsAt: toDateTimeLocal(initialValues?.startsAt),
    endsAt: toDateTimeLocal(initialValues?.endsAt),
    sortOrder: initialValues?.sortOrder ?? 0,
  });

  const handleChange = (field: keyof BannerFormValues, value: string | boolean) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit({
      ...values,
      description: values.description?.trim() || undefined,
      href: values.href?.trim() || undefined,
      startsAt: values.startsAt?.trim() || undefined,
      endsAt: values.endsAt?.trim() || undefined,
    });
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Title</span>
            <input
              value={values.title}
              onChange={(event) => handleChange('title', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Placement</span>
            <select
              value={values.placement}
              onChange={(event) => handleChange('placement', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
              required
            >
              {placementOptions.map((placement) => (
                <option key={placement} value={placement}>
                  {placement.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Description</span>
            <textarea
              value={values.description ?? ''}
              onChange={(event) => handleChange('description', event.target.value)}
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Image URL</span>
            <input
              value={values.imageUrl}
              onChange={(event) => handleChange('imageUrl', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Link URL</span>
            <input
              value={values.href ?? ''}
              onChange={(event) => handleChange('href', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Starts at</span>
            <input
              type="datetime-local"
              value={values.startsAt ?? ''}
              onChange={(event) => handleChange('startsAt', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Ends at</span>
            <input
              type="datetime-local"
              value={values.endsAt ?? ''}
              onChange={(event) => handleChange('endsAt', event.target.value)}
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

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={values.isActive}
              onChange={(event) => handleChange('isActive', event.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
            />
            <span>Active</span>
          </label>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>
            {submitLabel}
          </Button>
          {onDelete && canDelete ? (
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
