'use client';

import { useMemo, useState } from 'react';
import { AdminCategory, AdminProduct } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import Image from 'next/image';
import { uploadImage } from '@/lib/upload';
import { showError } from '@/lib/admin-alert';

interface ProductFormProps {
  categories: AdminCategory[];
  initialValues?: Partial<AdminProduct>;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
}

export type ProductFormValues = {
  sku: string;
  slug: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  imageUrl?: string;
  spicyLevel?: number;
  isBestSeller: boolean;
  isNew: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  stock: number;
  categoryId: string;
};

const statusOptions = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function ProductForm({
  categories,
  initialValues,
  onSubmit,
  onDelete,
  isSubmitting,
  isDeleting,
  submitLabel,
}: ProductFormProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [imagePreview, setImagePreview] = useState(
    initialValues?.imageUrl ?? '',
  );

  const [values, setValues] = useState<ProductFormValues>({
    sku: initialValues?.sku ?? '',
    slug: initialValues?.slug ?? '',
    name: initialValues?.name ?? '',
    description: initialValues?.description ?? '',
    price: initialValues?.price ?? 0,
    originalPrice: initialValues?.originalPrice ?? undefined,
    imageUrl: initialValues?.imageUrl ?? '',
    spicyLevel: initialValues?.spicyLevel ?? undefined,
    isBestSeller: initialValues?.isBestSeller ?? false,
    isNew: initialValues?.isNew ?? false,
    status:
      (initialValues?.status as ProductFormValues['status']) ??
      'ACTIVE',
    stock: initialValues?.stock ?? 0,
    categoryId: initialValues?.categoryId ?? categories[0]?.id ?? '',
  });

  const categoryOptions = useMemo(
    () => categories.map((category) => ({ value: category.id, label: category.name })),
    [categories],
  );

  const handleChange = (field: keyof ProductFormValues, value: string | boolean) => {
    setValues((current) => ({
      ...current,
      [field]: typeof value === 'string' && ['price', 'stock', 'originalPrice', 'spicyLevel'].includes(field)
        ? toNumber(value)
        : value,
    }));
  };

  const handleImageUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) return;

    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await uploadImage(formData);

      setValues((prev) => ({
        ...prev,
        imageUrl: response.url,
      }));

      setImagePreview(response.url);
    } catch (error) {
      console.error(error);
      void showError(error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    if (!values.imageUrl) {
      void showError(new Error('Please upload an image first'));
      return;
    }

    await onSubmit(values);
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>SKU</span>
            <input
              value={values.sku}
              onChange={(event) => handleChange('sku', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Slug</span>
            <input
              value={values.slug}
              onChange={(event) => handleChange('slug', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Name</span>
            <input
              value={values.name}
              onChange={(event) => handleChange('name', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Description</span>
            <textarea
              value={values.description}
              onChange={(event) => handleChange('description', event.target.value)}
              rows={5}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Price</span>
            <input
              type="number"
              min={0}
              value={values.price}
              onChange={(event) => handleChange('price', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Original Price</span>
            <input
              type="number"
              min={0}
              value={values.originalPrice ?? ''}
              onChange={(event) => handleChange('originalPrice', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Stock</span>
            <input
              type="number"
              min={0}
              value={values.stock}
              onChange={(event) => handleChange('stock', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Spicy Level</span>
            <input
              type="number"
              min={0}
              value={values.spicyLevel ?? ''}
              onChange={(event) => handleChange('spicyLevel', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Category</span>
            <select
              value={values.categoryId}
              onChange={(event) => handleChange('categoryId', event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
              required
            >
              {categoryOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Product Image</span>

            <input
              type="file"
              accept="image/*"
              onChange={handleImageUpload}
            />

            {isUploading && (
              <p className="text-xs text-gray-500">
                Uploading...
              </p>
            )}

            {imagePreview && (
              <img
                src={imagePreview}
                alt="Preview"
                className="mt-2 h-40 w-40 rounded-lg border object-cover"
              />
            )}
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Status</span>
            <select
              value={values.status}
              onChange={(event) => handleChange('status', event.target.value as ProductFormValues['status'])}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm outline-none focus:border-[#465fff]"
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-2 text-sm text-gray-700">
            <span>Flags</span>
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={values.isBestSeller}
                  onChange={(event) => handleChange('isBestSeller', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                Best seller
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={values.isNew}
                  onChange={(event) => handleChange('isNew', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                New
              </label>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            disabled={isSubmitting || isUploading}
          >
            {submitLabel}
          </Button>
          {onDelete ? (
            <Button
              type="button"
              disabled={isDeleting}
              className="
    bg-red-600
    text-white
    hover:bg-red-700
    focus:ring-red-500
  "
              onClick={async () => {
                // Confirmation is handled by the page's onDelete (SweetAlert confirmDelete).
                await onDelete?.();
              }}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
