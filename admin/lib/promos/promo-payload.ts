import type { AdminPromo } from '@/lib/admin';

/**
 * Promo form contract (Phase 4J).
 *
 * The form collects values; THIS module decides what reaches the API. It is kept
 * free of React so the payload rules are testable without a DOM.
 *
 * Two shapes of voucher share one form:
 *
 *  - legacy: voucherType plus its own column (discountPercentage /
 *    discountAmount / freeShippingMaxAmount), exactly as before Phase 4;
 *  - component: productDiscountType and/or shippingDiscountType with their own
 *    amounts, which stack. The legacy columns are inert for these - the backend
 *    stops reading them as soon as either component is set - so they are never
 *    sent alongside a component.
 *
 * voucherType stays the legacy Prisma enum. SHIPPING_PERCENTAGE / SHIPPING_FIXED
 * are NOT voucher types: a shipping discount is a component, and submitting those
 * strings is what the backend rejected with a 400.
 *
 * No money is computed here. The backend remains authoritative; this module only
 * decides which configuration fields are written.
 */

export const VOUCHER_TYPES = ['PERCENTAGE_DISCOUNT', 'FIXED_DISCOUNT', 'FREE_SHIPPING'] as const;
export type VoucherTypeValue = (typeof VOUCHER_TYPES)[number];

export const PRODUCT_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED'] as const;
export type ProductDiscountTypeValue = (typeof PRODUCT_DISCOUNT_TYPES)[number];

export const SHIPPING_DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED', 'FREE_SHIPPING'] as const;
export type ShippingDiscountTypeValue = (typeof SHIPPING_DISCOUNT_TYPES)[number];

/** Mirrors the backend DTO: @IsIn(['paxel', 'jne'], { each: true }). */
export const SUPPORTED_COURIERS = ['paxel', 'jne'] as const;
export type SupportedCourier = (typeof SUPPORTED_COURIERS)[number];

export const COURIER_LABELS: Record<SupportedCourier, string> = {
  paxel: 'Paxel',
  jne: 'JNE',
};

export type PromoFormValues = {
  code: string;
  title: string;
  description: string;
  imageUrl?: string;
  voucherType: VoucherTypeValue;
  // Legacy configuration.
  discountPercentage?: number;
  discountAmount?: number;
  maxDiscountAmount?: number;
  freeShippingMaxAmount?: number;
  // Phase 4 product component.
  productDiscountType?: ProductDiscountTypeValue;
  productDiscountPercentage?: number;
  productDiscountAmount?: number;
  productMaxDiscountAmount?: number;
  // Phase 4 shipping component.
  shippingDiscountType?: ShippingDiscountTypeValue;
  shippingDiscountPercentage?: number;
  shippingDiscountAmount?: number;
  shippingMaxDiscountAmount?: number;
  eligibleCouriers?: string[];
  // Shared.
  minimumOrderAmount?: number;
  maxUsageCount?: number;
  isNewUserOnly: boolean;
  startDate?: string;
  endDate?: string;
  isActive: boolean;
};

/** A voucher is component-based as soon as either component carries a type. */
export function hasProductComponent(values: PromoFormValues): boolean {
  return Boolean(values.productDiscountType);
}

export function hasShippingComponent(values: PromoFormValues): boolean {
  return Boolean(values.shippingDiscountType);
}

export function usesComponents(values: PromoFormValues): boolean {
  return hasProductComponent(values) || hasShippingComponent(values);
}

const isSupportedCourier = (value: unknown): value is SupportedCourier =>
  typeof value === 'string' && (SUPPORTED_COURIERS as readonly string[]).includes(value.toLowerCase());

/** Lower-cased, de-duplicated, unsupported entries dropped. */
export function normalizeCouriers(couriers?: string[] | null): SupportedCourier[] {
  if (!Array.isArray(couriers)) return [];
  const seen = new Set<SupportedCourier>();
  for (const courier of couriers) {
    if (!isSupportedCourier(courier)) continue;
    seen.add(courier.toLowerCase() as SupportedCourier);
  }
  return SUPPORTED_COURIERS.filter((courier) => seen.has(courier));
}

const asOptionalNumber = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined ? undefined : value;

const asVoucherType = (value: unknown): VoucherTypeValue =>
  (VOUCHER_TYPES as readonly string[]).includes(value as string) ? (value as VoucherTypeValue) : 'PERCENTAGE_DISCOUNT';

const asProductType = (value: unknown): ProductDiscountTypeValue | undefined =>
  (PRODUCT_DISCOUNT_TYPES as readonly string[]).includes(value as string)
    ? (value as ProductDiscountTypeValue)
    : undefined;

const asShippingType = (value: unknown): ShippingDiscountTypeValue | undefined =>
  (SHIPPING_DISCOUNT_TYPES as readonly string[]).includes(value as string)
    ? (value as ShippingDiscountTypeValue)
    : undefined;

/**
 * Edit flow: turns the stored promo into form values, components included, so an
 * existing component voucher opens on its own configuration instead of a blank
 * legacy form. `toDateTimeLocal` is injected because the date helper is a React
 * concern of the form.
 */
export function promoFormValuesFromPromo(
  promo: Partial<AdminPromo> | undefined,
  toDateTimeLocal: (value?: string | null) => string | undefined,
): PromoFormValues {
  return {
    code: promo?.code ?? '',
    title: promo?.title ?? '',
    description: promo?.description ?? '',
    imageUrl: promo?.imageUrl ?? '',
    voucherType: asVoucherType(promo?.voucherType),
    discountPercentage: asOptionalNumber(promo?.discountPercentage),
    discountAmount: asOptionalNumber(promo?.discountAmount),
    maxDiscountAmount: asOptionalNumber(promo?.maxDiscountAmount),
    freeShippingMaxAmount: asOptionalNumber(promo?.freeShippingMaxAmount),
    productDiscountType: asProductType(promo?.productDiscountType),
    productDiscountPercentage: asOptionalNumber(promo?.productDiscountPercentage),
    productDiscountAmount: asOptionalNumber(promo?.productDiscountAmount),
    productMaxDiscountAmount: asOptionalNumber(promo?.productMaxDiscountAmount),
    shippingDiscountType: asShippingType(promo?.shippingDiscountType),
    shippingDiscountPercentage: asOptionalNumber(promo?.shippingDiscountPercentage),
    shippingDiscountAmount: asOptionalNumber(promo?.shippingDiscountAmount),
    shippingMaxDiscountAmount: asOptionalNumber(promo?.shippingMaxDiscountAmount),
    eligibleCouriers: normalizeCouriers(promo?.eligibleCouriers),
    minimumOrderAmount: asOptionalNumber(promo?.minimumOrderAmount),
    maxUsageCount: asOptionalNumber(promo?.maxUsageCount),
    isNewUserOnly: promo?.isNewUserOnly ?? false,
    startDate: toDateTimeLocal(promo?.startDate),
    endDate: toDateTimeLocal(promo?.endDate),
    isActive: promo?.isActive ?? true,
  };
}

/** Drops the fields the newly chosen type cannot use, so nothing stale is kept. */
export function withProductDiscountType(
  values: PromoFormValues,
  type?: ProductDiscountTypeValue,
): PromoFormValues {
  if (!type) {
    return {
      ...values,
      productDiscountType: undefined,
      productDiscountPercentage: undefined,
      productDiscountAmount: undefined,
      productMaxDiscountAmount: undefined,
    };
  }
  return {
    ...values,
    productDiscountType: type,
    productDiscountPercentage: type === 'PERCENTAGE' ? values.productDiscountPercentage : undefined,
    productDiscountAmount: type === 'FIXED' ? values.productDiscountAmount : undefined,
  };
}

export function withShippingDiscountType(
  values: PromoFormValues,
  type?: ShippingDiscountTypeValue,
): PromoFormValues {
  if (!type) {
    return {
      ...values,
      shippingDiscountType: undefined,
      shippingDiscountPercentage: undefined,
      shippingDiscountAmount: undefined,
      shippingMaxDiscountAmount: undefined,
      eligibleCouriers: [],
    };
  }
  return {
    ...values,
    shippingDiscountType: type,
    shippingDiscountPercentage: type === 'PERCENTAGE' ? values.shippingDiscountPercentage : undefined,
    shippingDiscountAmount: type === 'FIXED' ? values.shippingDiscountAmount : undefined,
  };
}

export function withVoucherType(values: PromoFormValues, voucherType: VoucherTypeValue): PromoFormValues {
  return {
    ...values,
    voucherType,
    discountPercentage: voucherType === 'PERCENTAGE_DISCOUNT' ? values.discountPercentage : undefined,
    maxDiscountAmount: voucherType === 'PERCENTAGE_DISCOUNT' ? values.maxDiscountAmount : undefined,
    discountAmount: voucherType === 'FIXED_DISCOUNT' ? values.discountAmount : undefined,
    freeShippingMaxAmount: voucherType === 'FREE_SHIPPING' ? values.freeShippingMaxAmount : undefined,
  };
}

export function toggleCourier(values: PromoFormValues, courier: SupportedCourier, selected: boolean): PromoFormValues {
  const current = normalizeCouriers(values.eligibleCouriers);
  const next = selected ? [...current, courier] : current.filter((c) => c !== courier);
  return { ...values, eligibleCouriers: normalizeCouriers(next) };
}

const isUsableInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);

/**
 * Admin-facing validation, written to match the backend contract:
 * CreatePromoDto / UpdatePromoDto plus AdminService.validatePromoConfiguration.
 * The server still re-validates - this only keeps the admin from posting a
 * configuration it already knows will be refused.
 */
export function validatePromoForm(values: PromoFormValues): string[] {
  const errors: string[] = [];

  if (!values.code.trim()) errors.push('Kode voucher wajib diisi.');
  if (!values.title.trim()) errors.push('Judul wajib diisi.');
  if (!values.description.trim()) errors.push('Deskripsi wajib diisi.');

  const percentage = (value: unknown, label: string) => {
    if (!isUsableInteger(value) || value < 1 || value > 100) {
      errors.push(`${label} harus bilangan bulat antara 1 dan 100.`);
    }
  };
  const amount = (value: unknown, label: string) => {
    if (!isUsableInteger(value) || value < 1) {
      errors.push(`${label} harus bilangan bulat minimal 1.`);
    }
  };
  const optionalCap = (value: unknown, label: string) => {
    if (value === undefined || value === null) return;
    if (!isUsableInteger(value) || value < 0) {
      errors.push(`${label} harus bilangan bulat minimal 0.`);
    }
  };

  // Cap of an active discount component: empty means no cap, but a value must be
  // at least 1 - a cap of 0 would make the component grant nothing (Phase 4N.12,
  // mirrors CreatePromoDto / UpdatePromoDto and AdminService.assertPromoComponentCap).
  const optionalComponentCap = (value: unknown, label: string) => {
    if (value === undefined || value === null) return;
    if (!isUsableInteger(value) || value < 1) {
      errors.push(`${label} harus bilangan bulat minimal 1, atau dikosongkan jika tanpa batas.`);
    }
  };

  optionalCap(values.minimumOrderAmount, 'Minimal nilai pesanan');
  if (values.maxUsageCount !== undefined && (!isUsableInteger(values.maxUsageCount) || values.maxUsageCount < 1)) {
    errors.push('Maksimal jumlah pemakaian harus bilangan bulat minimal 1, atau dibiarkan kosong.');
  }

  if (usesComponents(values)) {
    if (hasProductComponent(values)) {
      if (values.productDiscountType === 'PERCENTAGE') {
        percentage(values.productDiscountPercentage, 'Persentase diskon produk');
      } else if (values.productDiscountType === 'FIXED') {
        amount(values.productDiscountAmount, 'Nominal diskon produk');
      } else {
        errors.push('Tipe diskon produk tidak dikenal.');
      }
      optionalComponentCap(values.productMaxDiscountAmount, 'Maksimal diskon produk');
    }

    if (hasShippingComponent(values)) {
      const couriers = normalizeCouriers(values.eligibleCouriers);
      const requested = Array.isArray(values.eligibleCouriers) ? values.eligibleCouriers : [];
      if (couriers.length === 0) {
        errors.push('Diskon ongkir wajib memiliki minimal satu kurir (Paxel atau JNE).');
      } else if (requested.some((courier) => !isSupportedCourier(courier))) {
        errors.push('Kurir yang didukung hanya Paxel dan JNE.');
      }

      if (values.shippingDiscountType === 'PERCENTAGE') {
        percentage(values.shippingDiscountPercentage, 'Persentase diskon ongkir');
      } else if (values.shippingDiscountType === 'FIXED') {
        amount(values.shippingDiscountAmount, 'Nominal diskon ongkir');
      } else if (values.shippingDiscountType !== 'FREE_SHIPPING') {
        errors.push('Tipe diskon ongkir tidak dikenal.');
      }
      optionalComponentCap(values.shippingMaxDiscountAmount, 'Maksimal diskon ongkir');
    }

    return errors;
  }

  // Legacy configuration.
  if (values.voucherType === 'PERCENTAGE_DISCOUNT') {
    percentage(values.discountPercentage, 'Persentase diskon');
    optionalCap(values.maxDiscountAmount, 'Maksimal nominal diskon');
  } else if (values.voucherType === 'FIXED_DISCOUNT') {
    amount(values.discountAmount, 'Nominal diskon');
  } else if (values.voucherType === 'FREE_SHIPPING') {
    optionalCap(values.freeShippingMaxAmount, 'Maksimal potongan gratis ongkir');
  }

  return errors;
}

export type PromoPayload = Partial<AdminPromo>;

/**
 * Builds the API body.
 *
 * On create only the fields the chosen configuration uses are written, so no
 * unrelated column is set. On update (PATCH) a field the configuration no longer
 * uses is sent as an explicit null - that is how a stale value is cleared, and
 * setting either component type to null makes the backend clear that whole
 * component group (AdminService.updatePromo). Fields outside this form, such as
 * currentUsageCount, are never part of the body, so PATCH leaves them untouched.
 */
export function buildPromoPayload(values: PromoFormValues, mode: 'create' | 'update'): PromoPayload {
  const clearing = mode === 'update';
  const clear = <T>(value: T | undefined): T | null | undefined => (clearing ? (value ?? null) : value);

  const payload: PromoPayload = {
    code: values.code.trim(),
    title: values.title.trim(),
    description: values.description.trim(),
    imageUrl: values.imageUrl?.trim() || undefined,
    voucherType: values.voucherType,
    minimumOrderAmount: values.minimumOrderAmount,
    maxUsageCount: clear(values.maxUsageCount),
    isNewUserOnly: values.isNewUserOnly,
    startDate: values.startDate?.trim() || (clearing ? null : undefined),
    endDate: values.endDate?.trim() || (clearing ? null : undefined),
    isActive: values.isActive,
  };

  if (usesComponents(values)) {
    // Component voucher: the legacy columns are inert, so they are cleared on
    // update and never written on create.
    payload.discountPercentage = clear(undefined);
    payload.discountAmount = clear(undefined);
    payload.maxDiscountAmount = clear(undefined);
    payload.freeShippingMaxAmount = clear(undefined);

    if (hasProductComponent(values)) {
      payload.productDiscountType = values.productDiscountType;
      payload.productDiscountPercentage = clear(
        values.productDiscountType === 'PERCENTAGE' ? values.productDiscountPercentage : undefined,
      );
      payload.productDiscountAmount = clear(
        values.productDiscountType === 'FIXED' ? values.productDiscountAmount : undefined,
      );
      payload.productMaxDiscountAmount = clear(values.productMaxDiscountAmount);
    } else if (clearing) {
      // The backend clears the rest of the group from this one null.
      payload.productDiscountType = null;
    }

    if (hasShippingComponent(values)) {
      payload.shippingDiscountType = values.shippingDiscountType;
      payload.shippingDiscountPercentage = clear(
        values.shippingDiscountType === 'PERCENTAGE' ? values.shippingDiscountPercentage : undefined,
      );
      payload.shippingDiscountAmount = clear(
        values.shippingDiscountType === 'FIXED' ? values.shippingDiscountAmount : undefined,
      );
      payload.shippingMaxDiscountAmount = clear(values.shippingMaxDiscountAmount);
      payload.eligibleCouriers = normalizeCouriers(values.eligibleCouriers);
    } else if (clearing) {
      payload.shippingDiscountType = null;
    }
  } else {
    // Legacy voucher: only the column its own type uses.
    payload.discountPercentage = clear(
      values.voucherType === 'PERCENTAGE_DISCOUNT' ? values.discountPercentage : undefined,
    );
    payload.maxDiscountAmount = clear(
      values.voucherType === 'PERCENTAGE_DISCOUNT' ? values.maxDiscountAmount : undefined,
    );
    payload.discountAmount = clear(values.voucherType === 'FIXED_DISCOUNT' ? values.discountAmount : undefined);
    payload.freeShippingMaxAmount = clear(
      values.voucherType === 'FREE_SHIPPING' ? values.freeShippingMaxAmount : undefined,
    );

    if (clearing) {
      payload.productDiscountType = null;
      payload.shippingDiscountType = null;
    }
  }

  // undefined keys would serialise away anyway; dropping them keeps the body and
  // the test expectations honest about what is actually sent.
  for (const key of Object.keys(payload) as Array<keyof PromoPayload>) {
    if (payload[key] === undefined) delete payload[key];
  }

  return payload;
}
