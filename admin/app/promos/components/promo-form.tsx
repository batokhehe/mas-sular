'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { AdminPromo } from '@/lib/admin';
import { toDateTimeLocalValue } from '@/lib/business-time';
import {
  COURIER_LABELS,
  PRODUCT_DISCOUNT_TYPES,
  SHIPPING_DISCOUNT_TYPES,
  SUPPORTED_COURIERS,
  hasProductComponent,
  hasShippingComponent,
  normalizeCouriers,
  promoFormValuesFromPromo,
  toggleCourier,
  usesComponents,
  validatePromoForm,
  withProductDiscountType,
  withShippingDiscountType,
  withVoucherType,
} from '@/lib/promos/promo-payload';
import type {
  ProductDiscountTypeValue,
  PromoFormValues,
  ShippingDiscountTypeValue,
  VoucherTypeValue,
} from '@/lib/promos/promo-payload';

// The value shape, the validation and the payload rules live in
// lib/promos/promo-payload.ts so they can be tested without a DOM. Re-exported
// here because the create and edit pages have always imported it from this file.
export type { PromoFormValues } from '@/lib/promos/promo-payload';

const INPUT_CLASS =
  'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-[#465fff] focus:bg-white';
const CHECKBOX_CLASS = 'h-4 w-4 rounded border-gray-300 text-[#465fff] focus:ring-[#465fff]';

const PRODUCT_TYPE_LABELS: Record<ProductDiscountTypeValue, string> = {
  PERCENTAGE: 'Persentase dari subtotal',
  FIXED: 'Nominal tetap',
};

const SHIPPING_TYPE_LABELS: Record<ShippingDiscountTypeValue, string> = {
  PERCENTAGE: 'Persentase dari ongkir',
  FIXED: 'Nominal tetap',
  FREE_SHIPPING: 'Gratis ongkir',
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
  // Hydrated from the stored promo, components included, so an existing
  // component voucher opens on its own configuration instead of a blank legacy
  // form. The API returns full ISO instants, which a datetime-local input refuses
  // outright (it sanitises anything carrying Z or an offset to ""), so the dates
  // are rendered as the Asia/Jakarta wall clock: what the admin typed in the
  // first place, and what the API reads a naked value back as.
  const [values, setValues] = useState<PromoFormValues>(() =>
    promoFormValuesFromPromo(initialValues, toDateTimeLocalValue),
  );
  const [showErrors, setShowErrors] = useState(false);

  const errors = useMemo(() => validatePromoForm(values), [values]);
  const productEnabled = hasProductComponent(values);
  const shippingEnabled = hasShippingComponent(values);
  const componentMode = usesComponents(values);
  const selectedCouriers = normalizeCouriers(values.eligibleCouriers);

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
    setShowErrors(true);
    // The backend re-validates everything; this only avoids a round trip for a
    // configuration the admin can still fix on screen.
    if (errors.length > 0) return;
    await onSubmit(values);
  };

  return (
    <Card>
      <CardTitle>{submitLabel}</CardTitle>
      <form onSubmit={handleSubmit} className="mt-4 space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-gray-700">
            <span>Kode</span>
            <input
              value={values.code}
              onChange={(event) => handleChange('code', event.target.value)}
              className={INPUT_CLASS}
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Judul</span>
            <input
              value={values.title}
              onChange={(event) => handleChange('title', event.target.value)}
              className={INPUT_CLASS}
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700 col-span-full">
            <span>Deskripsi</span>
            <textarea
              value={values.description}
              onChange={(event) => handleChange('description', event.target.value)}
              rows={4}
              className={INPUT_CLASS}
              required
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>URL gambar</span>
            <input
              value={values.imageUrl ?? ''}
              onChange={(event) => handleChange('imageUrl', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Tipe voucher</span>
            {/* The stored VoucherType enum: these three values only. A shipping
                discount is NOT a voucher type, it is the shipping component
                below. */}
            <select
              value={values.voucherType}
              onChange={(event) => setValues((current) => withVoucherType(current, event.target.value as VoucherTypeValue))}
              className={INPUT_CLASS}
            >
              <option value="PERCENTAGE_DISCOUNT">Diskon persentase (subtotal)</option>
              <option value="FIXED_DISCOUNT">Diskon nominal (subtotal)</option>
              <option value="FREE_SHIPPING">Gratis ongkir</option>
            </select>
          </label>

          {componentMode ? null : values.voucherType === 'PERCENTAGE_DISCOUNT' ? (
            <>
              <label className="space-y-2 text-sm text-gray-700">
                <span>Persentase diskon</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={values.discountPercentage ?? ''}
                  onChange={(event) => handleNumericChange('discountPercentage', event.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
              <label className="space-y-2 text-sm text-gray-700">
                <span>Maksimal nominal diskon</span>
                <input
                  type="number"
                  min={0}
                  value={values.maxDiscountAmount ?? ''}
                  onChange={(event) => handleNumericChange('maxDiscountAmount', event.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
            </>
          ) : values.voucherType === 'FIXED_DISCOUNT' ? (
            <label className="space-y-2 text-sm text-gray-700">
              <span>Nominal diskon</span>
              <input
                type="number"
                min={1}
                value={values.discountAmount ?? ''}
                onChange={(event) => handleNumericChange('discountAmount', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          ) : (
            <label className="space-y-2 text-sm text-gray-700">
              <span>Maksimal potongan gratis ongkir</span>
              <input
                type="number"
                min={0}
                value={values.freeShippingMaxAmount ?? ''}
                onChange={(event) => handleNumericChange('freeShippingMaxAmount', event.target.value)}
                className={INPUT_CLASS}
              />
            </label>
          )}

          <div className="col-span-full space-y-4 rounded-2xl border border-gray-200 bg-gray-50/70 p-4">
            <div>
              <p className="text-sm font-semibold text-gray-900">Komponen diskon</p>
              <p className="mt-1 text-xs text-gray-500">
                Diskon produk dan diskon ongkir dapat digabung dalam satu kode. Selama ada komponen aktif, kolom diskon
                lama di atas tidak dipakai dan tidak dikirim ke server.
              </p>
            </div>

            <div className="flex flex-wrap gap-6">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={productEnabled}
                  onChange={(event) =>
                    setValues((current) =>
                      withProductDiscountType(current, event.target.checked ? 'PERCENTAGE' : undefined),
                    )
                  }
                  className={CHECKBOX_CLASS}
                />
                <span>Aktifkan diskon produk</span>
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={shippingEnabled}
                  onChange={(event) =>
                    setValues((current) =>
                      withShippingDiscountType(current, event.target.checked ? 'PERCENTAGE' : undefined),
                    )
                  }
                  className={CHECKBOX_CLASS}
                />
                <span>Aktifkan diskon ongkir</span>
              </label>
            </div>

            {productEnabled ? (
              <div className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 lg:grid-cols-2">
                <p className="col-span-full text-sm font-medium text-gray-900">Diskon produk</p>
                <label className="space-y-2 text-sm text-gray-700">
                  <span>Tipe diskon produk</span>
                  <select
                    value={values.productDiscountType}
                    onChange={(event) =>
                      setValues((current) =>
                        withProductDiscountType(current, event.target.value as ProductDiscountTypeValue),
                      )
                    }
                    className={INPUT_CLASS}
                  >
                    {PRODUCT_DISCOUNT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {PRODUCT_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                {values.productDiscountType === 'PERCENTAGE' ? (
                  <label className="space-y-2 text-sm text-gray-700">
                    <span>Persentase diskon produk</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={values.productDiscountPercentage ?? ''}
                      onChange={(event) => handleNumericChange('productDiscountPercentage', event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                ) : (
                  <label className="space-y-2 text-sm text-gray-700">
                    <span>Nominal diskon produk</span>
                    <input
                      type="number"
                      min={1}
                      value={values.productDiscountAmount ?? ''}
                      onChange={(event) => handleNumericChange('productDiscountAmount', event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                )}
                <label className="space-y-2 text-sm text-gray-700">
                  <span>Maksimal diskon produk (opsional)</span>
                  <input
                    type="number"
                    min={0}
                    value={values.productMaxDiscountAmount ?? ''}
                    onChange={(event) => handleNumericChange('productMaxDiscountAmount', event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            ) : null}

            {shippingEnabled ? (
              <div className="grid gap-4 rounded-xl border border-gray-200 bg-white p-4 lg:grid-cols-2">
                <p className="col-span-full text-sm font-medium text-gray-900">Diskon ongkir</p>
                <label className="space-y-2 text-sm text-gray-700">
                  <span>Tipe diskon ongkir</span>
                  <select
                    value={values.shippingDiscountType}
                    onChange={(event) =>
                      setValues((current) =>
                        withShippingDiscountType(current, event.target.value as ShippingDiscountTypeValue),
                      )
                    }
                    className={INPUT_CLASS}
                  >
                    {SHIPPING_DISCOUNT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {SHIPPING_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                {values.shippingDiscountType === 'PERCENTAGE' ? (
                  <label className="space-y-2 text-sm text-gray-700">
                    <span>Persentase diskon ongkir</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={values.shippingDiscountPercentage ?? ''}
                      onChange={(event) => handleNumericChange('shippingDiscountPercentage', event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                ) : values.shippingDiscountType === 'FIXED' ? (
                  <label className="space-y-2 text-sm text-gray-700">
                    <span>Nominal diskon ongkir</span>
                    <input
                      type="number"
                      min={1}
                      value={values.shippingDiscountAmount ?? ''}
                      onChange={(event) => handleNumericChange('shippingDiscountAmount', event.target.value)}
                      className={INPUT_CLASS}
                    />
                  </label>
                ) : null}
                <label className="space-y-2 text-sm text-gray-700">
                  <span>Maksimal diskon ongkir (opsional)</span>
                  <input
                    type="number"
                    min={0}
                    value={values.shippingMaxDiscountAmount ?? ''}
                    onChange={(event) => handleNumericChange('shippingMaxDiscountAmount', event.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>
                <fieldset className="col-span-full space-y-2 text-sm text-gray-700">
                  <legend className="mb-1">Kurir yang berlaku</legend>
                  <div className="flex flex-wrap gap-4">
                    {SUPPORTED_COURIERS.map((courier) => (
                      <label key={courier} className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedCouriers.includes(courier)}
                          onChange={(event) =>
                            setValues((current) => toggleCourier(current, courier, event.target.checked))
                          }
                          className={CHECKBOX_CLASS}
                        />
                        <span>{COURIER_LABELS[courier]}</span>
                      </label>
                    ))}
                  </div>
                  {/* The backend refuses a shipping component without a courier,
                      and grants the discount only to a listed one. */}
                  <p className="text-xs text-gray-500">
                    Wajib minimal satu kurir. Diskon ongkir hanya berlaku untuk kurir yang dipilih.
                  </p>
                </fieldset>
              </div>
            ) : null}
          </div>

          <label className="space-y-2 text-sm text-gray-700">
            <span>Minimal nilai pesanan</span>
            <input
              type="number"
              min={0}
              value={values.minimumOrderAmount ?? ''}
              onChange={(event) => handleNumericChange('minimumOrderAmount', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Maksimal jumlah pemakaian</span>
            {/* Blank = unlimited (omitted -> null). The floor is 1, not 0: the backend
                enforces 0 as "tidak dapat dipakai" (hidden from the storefront, rejected at
                checkout), so a 0 here only ever produced a dead voucher. See
                lib/promos/usage-display.ts. */}
            <input
              type="number"
              min={1}
              placeholder="Unlimited"
              value={values.maxUsageCount ?? ''}
              onChange={(event) => handleNumericChange('maxUsageCount', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={values.isNewUserOnly}
              onChange={(event) => handleChange('isNewUserOnly', event.target.checked)}
              className={CHECKBOX_CLASS}
            />
            <span>Khusus pengguna baru</span>
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Mulai</span>
            <input
              type="datetime-local"
              value={values.startDate ?? ''}
              onChange={(event) => handleChange('startDate', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="space-y-2 text-sm text-gray-700">
            <span>Berakhir</span>
            <input
              type="datetime-local"
              value={values.endDate ?? ''}
              onChange={(event) => handleChange('endDate', event.target.value)}
              className={INPUT_CLASS}
            />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={values.isActive}
              onChange={(event) => handleChange('isActive', event.target.checked)}
              className={CHECKBOX_CLASS}
            />
            <span>Aktif</span>
          </label>
        </div>

        {showErrors && errors.length > 0 ? (
          <div role="alert" className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm text-red-700">
            <p className="font-medium">Periksa kembali konfigurasi voucher:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={isSubmitting}>{submitLabel}</Button>
          {onDelete ? (
            <Button type="button" className="bg-white text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50" disabled={isDeleting} onClick={onDelete}>
              Hapus
            </Button>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
