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
  voucherType: 'FREE_SHIPPING' | 'PERCENTAGE_DISCOUNT' | 'FIXED_DISCOUNT';
  discountPercentage?: number;
  discountAmount?: number;
  maxDiscountAmount?: number;
  freeShippingMaxAmount?: number;
  minimumOrderAmount?: number;
  maxUsageCount?: number;
  isNewUserOnly: boolean;
  startDate?: string;
  endDate?: string;
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
    voucherType: initialValues?.voucherType ?? 'PERCENTAGE_DISCOUNT',
    discountPercentage: initialValues?.discountPercentage ?? undefined,
    discountAmount: initialValues?.discountAmount ?? undefined,
    maxDiscountAmount: initialValues?.maxDiscountAmount ?? undefined,
    freeShippingMaxAmount: initialValues?.freeShippingMaxAmount ?? undefined,
    minimumOrderAmount: initialValues?.minimumOrderAmount ?? undefined,
    maxUsageCount: initialValues?.maxUsageCount ?? undefined,
    isNewUserOnly: initialValues?.isNewUserOnly ?? false,
    startDate: initialValues?.startDate ?? '',
    endDate: initialValues?.endDate ?? '',
    isActive: initialValues?.isActive ?? true,
  });

  const handleNumericChange = (field: keyof PromoFormValues, value: string) => {
    setValues((current) => ({
      ...current,
      [field]: value === '' ? undefined : Number(value),
    }));
  };

  const handleChange = (field: keyof PromoFormValues, value: string | boolean) => {
    setValues((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const sanitizedValues: PromoFormValues = {
      ...values,
      imageUrl: values.imageUrl?.trim() || undefined,
      startDate: values.startDate?.trim() || undefined,
      endDate: values.endDate?.trim() || undefined,
    };

    await onSubmit(sanitizedValues);
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
            <span>Voucher type</span>
            <select
              value={values.voucherType}
              onChange={(event) => handleChange('voucherType', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            >
              <option value="PERCENTAGE_DISCOUNT">Percentage discount</option>
              <option value="FIXED_DISCOUNT">Fixed discount</option>
              <option value="FREE_SHIPPING">Free shipping</option>
            </select>
          </label>

          {values.voucherType === 'PERCENTAGE_DISCOUNT' ? (
            <>
              <label className="space-y-2 text-sm text-gray-700">
                <span>Discount percentage</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={values.discountPercentage ?? ''}
                  onChange={(event) => handleNumericChange('discountPercentage', event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
                />
              </label>
              <label className="space-y-2 text-sm text-gray-700">
                <span>Max discount amount</span>
                <input
                  type="number"
                  min={0}
                  value={values.maxDiscountAmount ?? ''}
                  onChange={(event) => handleNumericChange('maxDiscountAmount', event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
                />
              </label>
            </>
          ) : values.voucherType === 'FIXED_DISCOUNT' ? (
            <label className="space-y-2 text-sm text-gray-700">
              <span>Discount amount</span>
              <input
                type="number"
                min={0}
                value={values.discountAmount ?? ''}
                onChange={(event) => handleNumericChange('discountAmount', event.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              />
            </label>
          ) : (
            <label className="space-y-2 text-sm text-gray-700">
              <span>Free shipping max amount</span>
              <input
                type="number"
                min={0}
                value={values.freeShippingMaxAmount ?? ''}
                onChange={(event) => handleNumericChange('freeShippingMaxAmount', event.target.value)}
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              />
            </label>
          )}

          <label className="space-y-2 text-sm text-gray-700">
            <span>Minimum order amount</span>
            <input
              type="number"
              min={0}
              value={values.minimumOrderAmount ?? ''}
              onChange={(event) => handleNumericChange('minimumOrderAmount', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Max usage count</span>
            <input
              type="number"
              min={0}
              value={values.maxUsageCount ?? ''}
              onChange={(event) => handleNumericChange('maxUsageCount', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={values.isNewUserOnly}
              onChange={(event) => handleChange('isNewUserOnly', event.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
            />
            <span>New users only</span>
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Starts at</span>
            <input
              type="datetime-local"
              value={values.startDate ?? ''}
              onChange={(event) => handleChange('startDate', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Ends at</span>
            <input
              type="datetime-local"
              value={values.endDate ?? ''}
              onChange={(event) => handleChange('endDate', event.target.value)}
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
