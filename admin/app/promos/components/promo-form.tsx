'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AdminPromo } from '@/lib/admin';

export type PromoFormValues = {
  code: string;
  title: string;
  description: string;
  imageUrl?: string;
  discountPct?: number;
  discountAmount?: number;
  minSubtotal?: number;
  startsAt?: string;
  endsAt?: string;
  isActive: boolean;
};

interface PromoFormProps {
  initialValues?: Partial<AdminPromo>;
  onSubmit: (values: PromoFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  submitLabel: string;
  isSubmitting?: boolean;
  isDeleting?: boolean;
}

export function PromoForm({
  initialValues,
  onSubmit,
  onDelete,
  submitLabel,
  isSubmitting,
  isDeleting,
}: PromoFormProps) {
  const [values, setValues] = useState<PromoFormValues>({
    code: initialValues?.code ?? '',
    title: initialValues?.title ?? '',
    description: initialValues?.description ?? '',
    imageUrl: initialValues?.imageUrl ?? '',
    discountPct: initialValues?.discountPct ?? undefined,
    discountAmount: initialValues?.discountAmount ?? undefined,
    minSubtotal: initialValues?.minSubtotal ?? undefined,
    startsAt: initialValues?.startsAt ?? '',
    endsAt: initialValues?.endsAt ?? '',
    isActive: initialValues?.isActive ?? true,
  });

  const handleChange = (field: keyof PromoFormValues, value: string | boolean) => {
    setValues((current) => ({
      ...current,
      [field]: typeof value === 'string' && ['discountPct', 'discountAmount', 'minSubtotal'].includes(field)
        ? (value === '' ? undefined : Number(value))
        : value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(values);
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Code</span>
            <input
              value={values.code}
              onChange={(event) => handleChange('code', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Title</span>
            <input
              value={values.title}
              onChange={(event) => handleChange('title', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Description</span>
            <textarea
              value={values.description}
              onChange={(event) => handleChange('description', event.target.value)}
              rows={4}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Image URL</span>
            <input
              value={values.imageUrl ?? ''}
              onChange={(event) => handleChange('imageUrl', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Discount pct</span>
            <input
              type="number"
              min={0}
              value={values.discountPct ?? ''}
              onChange={(event) => handleChange('discountPct', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Discount amount</span>
            <input
              type="number"
              min={0}
              value={values.discountAmount ?? ''}
              onChange={(event) => handleChange('discountAmount', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Minimum subtotal</span>
            <input
              type="number"
              min={0}
              value={values.minSubtotal ?? ''}
              onChange={(event) => handleChange('minSubtotal', event.target.value)}
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
          <Button type="submit" disabled={isSubmitting}>{submitLabel}</Button>
          {onDelete ? (
            <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" disabled={isDeleting} onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
