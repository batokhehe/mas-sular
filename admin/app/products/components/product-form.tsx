'use client';

import { useMemo, useState } from 'react';
import { AdminCategory, AdminProduct } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { uploadImage } from '@/lib/upload';
import { showError } from '@/lib/admin-alert';
import {
  PHYSICAL_LIMITS,
  PhysicalFormState,
  PhysicalNumericField,
  toPhysicalFormState,
  toPhysicalPayload,
  validatePhysicalState,
} from '@/lib/products/physical-attributes';
import {
  addImages,
  imageCounter,
  imagesPayload,
  initialImages,
  isCover,
  MAX_PRODUCT_IMAGES,
  moveImage,
  remainingSlots,
  removeImage,
  uploadSequentially,
} from '@/lib/products/product-images';

interface ProductFormProps {
  categories: AdminCategory[];
  initialValues?: Partial<AdminProduct>;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  onDelete?: () => Promise<void>;
  isSubmitting?: boolean;
  isDeleting?: boolean;
  submitLabel: string;
}

// No `sku` (P2 #5): it is internal and never shown. The form never sends one, so the
// backend assigns it from the slug on create and leaves it untouched on edit.
export type ProductFormValues = {
  slug: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number;
  /** Cover, always images[0] when saved (P2). */
  imageUrl?: string;
  /** P2 gallery in display order; images[0] is the cover. Sent on every save. */
  images?: string[];
  spicyLevel?: number;
  isBestSeller: boolean;
  isNew: boolean;
  isPromoSpecial: boolean;
  isTrialPack: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  stock: number;
  categoryId: string;
  // Physical attributes. Optional on the wire: an unmeasured field is OMITTED
  // rather than sent as 0/null, so saving an unrelated edit leaves a NULL
  // measurement untouched.
  weightGram?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  isFragile?: boolean;
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
  // P2 gallery, ordered, index 0 = cover. Starts from the stored images, or from the
  // existing imageUrl for a product without gallery rows (legacy covers stay usable).
  const [images, setImages] = useState<string[]>(() => initialImages(initialValues));

  const [values, setValues] = useState<ProductFormValues>({
    slug: initialValues?.slug ?? '',
    name: initialValues?.name ?? '',
    description: initialValues?.description ?? '',
    price: initialValues?.price ?? 0,
    originalPrice: initialValues?.originalPrice ?? undefined,
    imageUrl: initialValues?.imageUrl ?? '',
    spicyLevel: initialValues?.spicyLevel ?? undefined,
    isBestSeller: initialValues?.isBestSeller ?? false,
    isNew: initialValues?.isNew ?? false,
    isPromoSpecial: initialValues?.isPromoSpecial ?? false,
    isTrialPack: initialValues?.isTrialPack ?? false,
    status:
      (initialValues?.status as ProductFormValues['status']) ??
      'ACTIVE',
    stock: initialValues?.stock ?? 0,
    categoryId: initialValues?.categoryId ?? categories[0]?.id ?? '',
  });

  // Held separately as strings so an unmeasured product shows an EMPTY box.
  // Folding these into `values` as numbers would turn "no measurement" into 0.
  const [physical, setPhysical] = useState<PhysicalFormState>(() => toPhysicalFormState(initialValues));
  const [physicalErrors, setPhysicalErrors] = useState<string[]>([]);

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

  // Uploads through the EXISTING endpoint, one file at a time. Each success lands in
  // the gallery immediately, so a failure keeps every earlier upload and the rest of
  // the form; removing an image later never deletes the uploaded file.
  const handleImageUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setIsUploading(true);
    try {
      const outcome = await uploadSequentially(
        files,
        remainingSlots(images),
        async (file) => {
          const formData = new FormData();
          formData.append('file', file);
          const response = await uploadImage(formData);
          return response.url as string;
        },
        (url) => setImages((current) => addImages(current, [url])),
      );
      if (outcome.error) {
        console.error(outcome.error);
        void showError(
          new Error(
            `Image upload failed after ${outcome.uploaded.length} of ${files.length - outcome.skipped} file(s). The images already uploaded are kept; please try the rest again.`,
          ),
        );
      } else if (outcome.skipped > 0) {
        void showError(new Error(`A product can have at most ${MAX_PRODUCT_IMAGES} images; ${outcome.skipped} file(s) were not added.`));
      }
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();

    const gallery = imagesPayload(images);
    if (!gallery) {
      void showError(new Error('Please upload an image first'));
      return;
    }

    // Refuse rather than round or clamp: a silently corrected measurement ships
    // a parcel that is not the one described.
    const errors = validatePhysicalState(physical);
    setPhysicalErrors(errors);
    if (errors.length) {
      void showError(new Error(errors.join(' ')));
      return;
    }

    // Empty measurements are omitted here, so an untouched NULL stays NULL.
    // images[] in display order; imageUrl is its first image (the cover).
    await onSubmit({ ...values, ...gallery, ...toPhysicalPayload(physical) });
  };

  const handlePhysicalChange = (field: PhysicalNumericField, value: string) => {
    setPhysical((current) => ({ ...current, [field]: value }));
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
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
          <div className="space-y-2 text-sm text-gray-700 col-span-full">
            <div className="flex items-center justify-between">
              <span>Product Images</span>
              <span className="text-xs text-gray-500" aria-live="polite">
                {imageCounter(images)}
              </span>
            </div>
            <p className="text-xs text-gray-500">
              The first image is the cover. Up to {MAX_PRODUCT_IMAGES} images.
            </p>

            <input
              id="product-images-input"
              type="file"
              accept="image/*"
              multiple
              disabled={isUploading || remainingSlots(images) === 0}
              onChange={handleImageUpload}
            />

            {isUploading && (
              <p className="text-xs text-gray-500">
                Uploading...
              </p>
            )}

            {images.length > 0 && (
              <ul className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {images.map((url, index) => (
                  <li key={url} className="space-y-2 rounded-xl border border-gray-200 p-2">
                    <div className="relative">
                      <img
                        src={url}
                        alt={`Product image ${index + 1}`}
                        className="h-32 w-full rounded-lg border object-cover"
                      />
                      {isCover(index) && (
                        <span className="absolute left-2 top-2 rounded-md bg-[#465fff] px-2 py-0.5 text-xs font-semibold text-white">
                          Cover
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => setImages((current) => moveImage(current, index, -1))}
                        disabled={index === 0}
                        aria-label={`Move image ${index + 1} up`}
                        className="flex-1 rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:opacity-40"
                      >
                        ↑ Up
                      </button>
                      <button
                        type="button"
                        onClick={() => setImages((current) => moveImage(current, index, 1))}
                        disabled={index === images.length - 1}
                        aria-label={`Move image ${index + 1} down`}
                        className="flex-1 rounded-lg border border-gray-200 px-2 py-1 text-xs disabled:opacity-40"
                      >
                        ↓ Down
                      </button>
                      <button
                        type="button"
                        onClick={() => setImages((current) => removeImage(current, index))}
                        aria-label={`Remove image ${index + 1}`}
                        className="flex-1 rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={values.isPromoSpecial}
                  onChange={(event) => handleChange('isPromoSpecial', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                Promo Special
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={values.isTrialPack}
                  onChange={(event) => handleChange('isTrialPack', event.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
                />
                Trial Pack
              </label>
            </div>
            <p className="text-xs text-gray-500">
              Promo Special and Trial Pack products appear in the storefront homepage sections &quot;Promo Spesial
              Produk&quot; and &quot;Trial Pack&quot;.
            </p>
          </div>
        </div>

        {/* Physical Product Data — the real measurements of the item itself.
            Required by Paxel to book a shipment (items[].weight/length/width/
            height) and used as the shipping rate weight. Deliberately NOT the
            PaxelBox: the outer carton is chosen from total order quantity. */}
        <div className="space-y-3 border-t border-gray-100 pt-6">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Physical Product Data</h3>
            <p className="mt-1 text-xs text-gray-500">
              Real measurements of the product itself. Required before this product can be shipped —
              shipping is quoted from the actual weight, and the courier needs the dimensions to book.
              Leave blank if not yet measured; blank values are left unchanged.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            {([
              ['weightGram', 'Weight (gram)'],
              ['lengthCm', 'Length (cm)'],
              ['widthCm', 'Width (cm)'],
              ['heightCm', 'Height (cm)'],
            ] as Array<[PhysicalNumericField, string]>).map(([field, labelText]) => (
              <label key={field} className="space-y-2 text-sm text-gray-700">
                <span>{labelText}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={PHYSICAL_LIMITS[field].min}
                  max={PHYSICAL_LIMITS[field].max}
                  placeholder={`${PHYSICAL_LIMITS[field].min}–${PHYSICAL_LIMITS[field].max}`}
                  value={physical[field]}
                  onChange={(event) => handlePhysicalChange(field, event.target.value)}
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
                />
                <span className="block text-xs text-gray-400">
                  {PHYSICAL_LIMITS[field].min}–{PHYSICAL_LIMITS[field].max} {PHYSICAL_LIMITS[field].unit}, whole numbers only
                </span>
              </label>
            ))}
          </div>

          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={physical.isFragile}
              onChange={(event) => setPhysical((current) => ({ ...current, isFragile: event.target.checked }))}
              className="h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]"
            />
            Fragile
          </label>

          {physicalErrors.length > 0 ? (
            <ul className="space-y-1 text-sm text-red-600">
              {physicalErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
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
