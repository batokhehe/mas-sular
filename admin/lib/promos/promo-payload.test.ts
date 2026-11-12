import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRODUCT_DISCOUNT_TYPES,
  SHIPPING_DISCOUNT_TYPES,
  SUPPORTED_COURIERS,
  VOUCHER_TYPES,
  buildPromoPayload,
  normalizeCouriers,
  promoFormValuesFromPromo,
  toggleCourier,
  validatePromoForm,
  withProductDiscountType,
  withShippingDiscountType,
  withVoucherType,
} from './promo-payload.ts';
import type { PromoFormValues } from './promo-payload.ts';

// Phase 4J. The admin form used to offer SHIPPING_PERCENTAGE / SHIPPING_FIXED as
// voucher types; those are not VoucherType members, so the backend answered 400,
// and the form had no inputs for the real component fields at all. These tests
// pin the payload contract against CreatePromoDto / UpdatePromoDto and
// AdminService.validatePromoConfiguration.

const base = (overrides: Partial<PromoFormValues> = {}): PromoFormValues => ({
  code: 'PHASE4',
  title: 'Promo Phase 4',
  description: 'Deskripsi promo',
  voucherType: 'PERCENTAGE_DISCOUNT',
  isNewUserOnly: false,
  isActive: true,
  ...overrides,
});

const identityDate = (value?: string | null) => value ?? undefined;

// --- legacy compatibility --------------------------------------------------

test('legacy percentage promo creates the same payload as before', () => {
  const values = base({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, maxDiscountAmount: 20000 });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.voucherType, 'PERCENTAGE_DISCOUNT');
  assert.equal(payload.discountPercentage, 10);
  assert.equal(payload.maxDiscountAmount, 20000);
  // No component key is invented for a legacy voucher.
  assert.equal('productDiscountType' in payload, false);
  assert.equal('shippingDiscountType' in payload, false);
  assert.equal('eligibleCouriers' in payload, false);
});

test('legacy fixed promo creates a valid payload', () => {
  const values = base({ voucherType: 'FIXED_DISCOUNT', discountAmount: 5000 });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.voucherType, 'FIXED_DISCOUNT');
  assert.equal(payload.discountAmount, 5000);
  assert.equal('discountPercentage' in payload, false);
});

test('legacy free shipping promo creates a valid payload, cap optional', () => {
  const withCap = base({ voucherType: 'FREE_SHIPPING', freeShippingMaxAmount: 15000 });
  assert.deepEqual(validatePromoForm(withCap), []);
  assert.equal(buildPromoPayload(withCap, 'create').freeShippingMaxAmount, 15000);

  const withoutCap = base({ voucherType: 'FREE_SHIPPING' });
  assert.deepEqual(validatePromoForm(withoutCap), []);
  assert.equal('freeShippingMaxAmount' in buildPromoPayload(withoutCap, 'create'), false);
});

test('no payload ever carries SHIPPING_PERCENTAGE or SHIPPING_FIXED as a voucher type', () => {
  assert.deepEqual([...VOUCHER_TYPES], ['PERCENTAGE_DISCOUNT', 'FIXED_DISCOUNT', 'FREE_SHIPPING']);
  const shippingVoucher = base({
    voucherType: 'FREE_SHIPPING',
    shippingDiscountType: 'PERCENTAGE',
    shippingDiscountPercentage: 50,
    eligibleCouriers: ['jne'],
  });
  const payload = buildPromoPayload(shippingVoucher, 'create');
  assert.ok((VOUCHER_TYPES as readonly string[]).includes(payload.voucherType as string));
});

// --- product component -----------------------------------------------------

test('product percentage component submits a valid payload with no legacy fields', () => {
  const values = base({ productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, productMaxDiscountAmount: 20000 });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.productDiscountType, 'PERCENTAGE');
  assert.equal(payload.productDiscountPercentage, 10);
  assert.equal(payload.productMaxDiscountAmount, 20000);
  assert.equal('productDiscountAmount' in payload, false);
  // The legacy columns are inert for a component voucher and are not written.
  assert.equal('discountPercentage' in payload, false);
  assert.equal('discountAmount' in payload, false);
  assert.equal('maxDiscountAmount' in payload, false);
  assert.equal('freeShippingMaxAmount' in payload, false);
});

test('product fixed component submits a valid payload', () => {
  const values = base({ productDiscountType: 'FIXED', productDiscountAmount: 5000 });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.productDiscountType, 'FIXED');
  assert.equal(payload.productDiscountAmount, 5000);
  assert.equal('productDiscountPercentage' in payload, false);
});

// --- shipping component ----------------------------------------------------

test('shipping percentage component submits a valid payload', () => {
  const values = base({
    shippingDiscountType: 'PERCENTAGE',
    shippingDiscountPercentage: 50,
    shippingMaxDiscountAmount: 8000,
    eligibleCouriers: ['paxel'],
  });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.shippingDiscountType, 'PERCENTAGE');
  assert.equal(payload.shippingDiscountPercentage, 50);
  assert.equal(payload.shippingMaxDiscountAmount, 8000);
  assert.deepEqual(payload.eligibleCouriers, ['paxel']);
});

test('shipping fixed component submits a valid payload', () => {
  const values = base({ shippingDiscountType: 'FIXED', shippingDiscountAmount: 3000, eligibleCouriers: ['jne'] });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.shippingDiscountType, 'FIXED');
  assert.equal(payload.shippingDiscountAmount, 3000);
  assert.equal('shippingDiscountPercentage' in payload, false);
});

test('shipping free-shipping component needs no amount, only a courier', () => {
  const values = base({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel', 'jne'] });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.shippingDiscountType, 'FREE_SHIPPING');
  assert.deepEqual(payload.eligibleCouriers, ['paxel', 'jne']);
  assert.equal('shippingDiscountAmount' in payload, false);
  assert.equal('shippingDiscountPercentage' in payload, false);
});

test('a shipping component without eligible couriers is blocked', () => {
  const missing = base({ shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50 });
  assert.ok(validatePromoForm(missing).some((e) => e.includes('minimal satu kurir')));

  const empty = base({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: [] });
  assert.ok(validatePromoForm(empty).some((e) => e.includes('minimal satu kurir')));
});

test('an unsupported courier cannot be submitted', () => {
  const values = base({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['gojek'] });
  // Nothing usable is left, so this reads as "pick a courier".
  assert.ok(validatePromoForm(values).length > 0);
  // And it can never reach the API, whatever the form state says.
  assert.deepEqual(buildPromoPayload(values, 'create').eligibleCouriers, []);

  const mixed = base({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne', 'grab'] });
  assert.ok(validatePromoForm(mixed).some((e) => e.includes('Paxel dan JNE')));
  assert.deepEqual(buildPromoPayload(mixed, 'create').eligibleCouriers, ['jne']);
});

test('couriers are normalised: lower-cased, de-duplicated, unsupported dropped', () => {
  assert.deepEqual(normalizeCouriers(['JNE', 'jne', 'Paxel', 'gojek']), ['paxel', 'jne']);
  assert.deepEqual(normalizeCouriers(undefined), []);
  assert.deepEqual(normalizeCouriers('jne' as unknown as string[]), []);
});

test('toggling a courier adds and removes it without duplicating', () => {
  let values = base({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: [] });
  values = toggleCourier(values, 'jne', true);
  values = toggleCourier(values, 'jne', true);
  assert.deepEqual(values.eligibleCouriers, ['jne']);
  values = toggleCourier(values, 'paxel', true);
  assert.deepEqual(values.eligibleCouriers, ['paxel', 'jne']);
  values = toggleCourier(values, 'jne', false);
  assert.deepEqual(values.eligibleCouriers, ['paxel']);
});

// --- combined --------------------------------------------------------------

test('a combined product and shipping configuration submits both components', () => {
  const values = base({
    voucherType: 'PERCENTAGE_DISCOUNT',
    productDiscountType: 'PERCENTAGE',
    productDiscountPercentage: 10,
    shippingDiscountType: 'FIXED',
    shippingDiscountAmount: 3000,
    eligibleCouriers: ['jne'],
  });
  assert.deepEqual(validatePromoForm(values), []);
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.productDiscountType, 'PERCENTAGE');
  assert.equal(payload.productDiscountPercentage, 10);
  assert.equal(payload.shippingDiscountType, 'FIXED');
  assert.equal(payload.shippingDiscountAmount, 3000);
  assert.deepEqual(payload.eligibleCouriers, ['jne']);
  // No discount arithmetic happens client-side.
  assert.equal('discount' in payload, false);
  assert.equal('voucherDiscountAmount' in payload, false);
});

// --- edit flow -------------------------------------------------------------

test('the edit form hydrates an existing component voucher', () => {
  const values = promoFormValuesFromPromo(
    {
      id: 'promo-1',
      code: 'STACK10',
      title: 'Stack',
      description: 'Diskon produk dan ongkir',
      voucherType: 'PERCENTAGE_DISCOUNT',
      discountPercentage: null,
      productDiscountType: 'PERCENTAGE',
      productDiscountPercentage: 15,
      productMaxDiscountAmount: 20000,
      shippingDiscountType: 'FIXED',
      shippingDiscountAmount: 4000,
      eligibleCouriers: ['JNE'],
      minimumOrderAmount: 50000,
      currentUsageCount: 7,
      isNewUserOnly: false,
      startDate: null,
      endDate: null,
      isActive: true,
    },
    identityDate,
  );

  assert.equal(values.productDiscountType, 'PERCENTAGE');
  assert.equal(values.productDiscountPercentage, 15);
  assert.equal(values.productMaxDiscountAmount, 20000);
  assert.equal(values.shippingDiscountType, 'FIXED');
  assert.equal(values.shippingDiscountAmount, 4000);
  assert.deepEqual(values.eligibleCouriers, ['jne']);
  assert.equal(values.minimumOrderAmount, 50000);
  assert.deepEqual(validatePromoForm(values), []);
});

test('the edit form hydrates a legacy voucher into legacy mode', () => {
  const values = promoFormValuesFromPromo(
    {
      code: 'OLD10',
      title: 'Legacy',
      description: 'Legacy voucher',
      voucherType: 'FIXED_DISCOUNT',
      discountAmount: 5000,
      productDiscountType: null,
      shippingDiscountType: null,
      eligibleCouriers: null,
      minimumOrderAmount: 0,
      isNewUserOnly: false,
      isActive: true,
    },
    identityDate,
  );
  assert.equal(values.discountAmount, 5000);
  assert.equal(values.productDiscountType, undefined);
  assert.equal(values.shippingDiscountType, undefined);
  assert.deepEqual(values.eligibleCouriers, []);
});

test('an unknown stored voucher type falls back to a valid one', () => {
  const values = promoFormValuesFromPromo(
    { voucherType: 'SHIPPING_PERCENTAGE' as never, minimumOrderAmount: 0, isNewUserOnly: false, isActive: true },
    identityDate,
  );
  assert.ok((VOUCHER_TYPES as readonly string[]).includes(values.voucherType));
});

// --- switching types does not submit stale values --------------------------

test('switching a product component from percentage to fixed drops the percentage', () => {
  const start = base({ productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 });
  const switched = withProductDiscountType(start, 'FIXED');
  assert.equal(switched.productDiscountPercentage, undefined);
  const payload = buildPromoPayload({ ...switched, productDiscountAmount: 5000 }, 'create');
  assert.equal('productDiscountPercentage' in payload, false);
  assert.equal(payload.productDiscountAmount, 5000);
});

test('switching a shipping component to free shipping drops its amounts', () => {
  const start = base({
    shippingDiscountType: 'FIXED',
    shippingDiscountAmount: 3000,
    eligibleCouriers: ['jne'],
  });
  const switched = withShippingDiscountType(start, 'FREE_SHIPPING');
  assert.equal(switched.shippingDiscountAmount, undefined);
  // The courier selection survives the type switch; only the amount is dropped.
  assert.deepEqual(switched.eligibleCouriers, ['jne']);
  const payload = buildPromoPayload(switched, 'create');
  assert.equal('shippingDiscountAmount' in payload, false);
});

test('disabling a component drops every field of that component', () => {
  const start = base({
    shippingDiscountType: 'PERCENTAGE',
    shippingDiscountPercentage: 50,
    shippingMaxDiscountAmount: 8000,
    eligibleCouriers: ['jne'],
  });
  const off = withShippingDiscountType(start, undefined);
  assert.equal(off.shippingDiscountType, undefined);
  assert.equal(off.shippingDiscountPercentage, undefined);
  assert.equal(off.shippingMaxDiscountAmount, undefined);
  assert.deepEqual(off.eligibleCouriers, []);
});

test('switching the legacy voucher type drops the other legacy columns', () => {
  const start = base({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, maxDiscountAmount: 20000 });
  const switched = withVoucherType(start, 'FREE_SHIPPING');
  assert.equal(switched.discountPercentage, undefined);
  assert.equal(switched.maxDiscountAmount, undefined);
  const payload = buildPromoPayload(switched, 'create');
  assert.equal('discountPercentage' in payload, false);
  assert.equal('maxDiscountAmount' in payload, false);
});

// --- PATCH semantics -------------------------------------------------------

test('PATCH clears the fields the new configuration stopped using', () => {
  // A legacy percentage voucher becomes a shipping component voucher.
  const values = base({
    voucherType: 'FREE_SHIPPING',
    shippingDiscountType: 'FREE_SHIPPING',
    eligibleCouriers: ['jne'],
  });
  const payload = buildPromoPayload(values, 'update');
  assert.equal(payload.discountPercentage, null);
  assert.equal(payload.discountAmount, null);
  assert.equal(payload.maxDiscountAmount, null);
  assert.equal(payload.freeShippingMaxAmount, null);
  // The product component is removed; one null tells the backend to clear the group.
  assert.equal(payload.productDiscountType, null);
  assert.equal(payload.shippingDiscountType, 'FREE_SHIPPING');
});

test('PATCH back to a legacy voucher clears both components', () => {
  const values = base({ voucherType: 'FIXED_DISCOUNT', discountAmount: 5000 });
  const payload = buildPromoPayload(values, 'update');
  assert.equal(payload.productDiscountType, null);
  assert.equal(payload.shippingDiscountType, null);
  assert.equal(payload.discountAmount, 5000);
  assert.equal(payload.discountPercentage, null);
});

test('PATCH never carries fields this form does not own', () => {
  const values = base({ productDiscountType: 'FIXED', productDiscountAmount: 5000 });
  const payload = buildPromoPayload(values, 'update') as Record<string, unknown>;
  for (const key of ['id', 'currentUsageCount', 'createdAt', 'updatedAt', 'deletedAt', 'usages', 'orders']) {
    assert.equal(key in payload, false, key + ' must not be sent');
  }
});

test('a blank optional value is omitted on create and cleared on update', () => {
  const values = base({ voucherType: 'FIXED_DISCOUNT', discountAmount: 5000 });
  assert.equal('maxUsageCount' in buildPromoPayload(values, 'create'), false);
  assert.equal(buildPromoPayload(values, 'update').maxUsageCount, null);
  assert.equal('startDate' in buildPromoPayload(values, 'create'), false);
  assert.equal(buildPromoPayload(values, 'update').startDate, null);
});

test('code, title and description are trimmed', () => {
  const values = base({ code: '  SALE10 ', title: ' Judul ', description: ' Deskripsi ', discountPercentage: 10 });
  const payload = buildPromoPayload(values, 'create');
  assert.equal(payload.code, 'SALE10');
  assert.equal(payload.title, 'Judul');
  assert.equal(payload.description, 'Deskripsi');
});

// --- numeric validation ----------------------------------------------------

test('invalid numeric values are rejected', () => {
  const cases: Array<[string, Partial<PromoFormValues>]> = [
    ['product percentage 0', { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 0 }],
    ['product percentage 101', { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 101 }],
    ['product percentage 10.5', { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10.5 }],
    ['product percentage missing', { productDiscountType: 'PERCENTAGE' }],
    ['product amount 0', { productDiscountType: 'FIXED', productDiscountAmount: 0 }],
    ['product amount missing', { productDiscountType: 'FIXED' }],
    [
      'product cap negative',
      { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, productMaxDiscountAmount: -1 },
    ],
    [
      'shipping percentage 200',
      { shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 200, eligibleCouriers: ['jne'] },
    ],
    ['shipping amount missing', { shippingDiscountType: 'FIXED', eligibleCouriers: ['jne'] }],
    [
      'shipping cap negative',
      { shippingDiscountType: 'FREE_SHIPPING', shippingMaxDiscountAmount: -5, eligibleCouriers: ['jne'] },
    ],
    ['legacy percentage missing', { voucherType: 'PERCENTAGE_DISCOUNT' }],
    ['legacy percentage 0', { voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 0 }],
    ['legacy amount 0', { voucherType: 'FIXED_DISCOUNT', discountAmount: 0 }],
    ['legacy free shipping cap negative', { voucherType: 'FREE_SHIPPING', freeShippingMaxAmount: -1 }],
    ['usage limit 0', { voucherType: 'FIXED_DISCOUNT', discountAmount: 5000, maxUsageCount: 0 }],
  ];
  for (const [label, overrides] of cases) {
    assert.ok(validatePromoForm(base(overrides)).length > 0, label + ' must be rejected');
  }
});

test('required text fields are enforced', () => {
  const values = base({ code: '  ', title: '', description: ' ', discountPercentage: 10 });
  const errors = validatePromoForm(values);
  assert.equal(errors.length, 3);
});

// --- backend contract consistency -----------------------------------------

test('the client constants match the backend DTO contract', () => {
  // Read the backend DTO rather than trusting a copy of its rules: if the server
  // widens or narrows these sets, this test is the thing that notices.
  const dto = readFileSync(
    new URL('../../../backend/src/modules/admin/application/dto/create-promo.dto.ts', import.meta.url),
    'utf8',
  );
  assert.match(dto, /IsIn\(\['paxel', 'jne'\]/, 'courier allowlist drifted from the DTO');
  assert.deepEqual([...SUPPORTED_COURIERS], ['paxel', 'jne']);

  const schema = readFileSync(new URL('../../../backend/prisma/schema.prisma', import.meta.url), 'utf8');
  const productEnum = schema.match(/enum ProductDiscountType \{([^}]*)\}/);
  const shippingEnum = schema.match(/enum ShippingDiscountType \{([^}]*)\}/);
  assert.ok(productEnum && shippingEnum, 'component enums missing from the Prisma schema');
  const members = (block: string) => block.trim().split(/\s+/).sort();
  assert.deepEqual(members(productEnum[1]), [...PRODUCT_DISCOUNT_TYPES].sort());
  assert.deepEqual(members(shippingEnum[1]), [...SHIPPING_DISCOUNT_TYPES].sort());

  const voucherEnum = schema.match(/enum VoucherType \{([^}]*)\}/);
  assert.ok(voucherEnum, 'VoucherType missing from the Prisma schema');
  assert.deepEqual(members(voucherEnum[1]), [...VOUCHER_TYPES].sort());
});

// --- Phase 4N.12: zero discount cap -----------------------------------------

test('a component cap of 0 is rejected (product and shipping)', () => {
  const product = validatePromoForm(
    base({ productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, productMaxDiscountAmount: 0 }),
  );
  assert.deepEqual(product, ['Maksimal diskon produk harus bilangan bulat minimal 1, atau dikosongkan jika tanpa batas.']);

  const shipping = validatePromoForm(
    base({ shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, shippingMaxDiscountAmount: 0, eligibleCouriers: ['jne'] }),
  );
  assert.deepEqual(shipping, ['Maksimal diskon ongkir harus bilangan bulat minimal 1, atau dikosongkan jika tanpa batas.']);
});

test('an empty component cap (no cap) and a positive cap are accepted', () => {
  const noCap = base({
    productDiscountType: 'FIXED',
    productDiscountAmount: 5000,
    shippingDiscountType: 'FREE_SHIPPING',
    eligibleCouriers: ['paxel'],
  });
  assert.deepEqual(validatePromoForm(noCap), []);
  assert.deepEqual(validatePromoForm({ ...noCap, productMaxDiscountAmount: 1, shippingMaxDiscountAmount: 15000 }), []);
});

test('legacy caps keep their existing rule (0 still allowed)', () => {
  assert.deepEqual(
    validatePromoForm(base({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, maxDiscountAmount: 0 })),
    [],
  );
});

test('the component cap rule matches the backend DTO', () => {
  const dto = readFileSync(
    new URL('../../../backend/src/modules/admin/application/dto/create-promo.dto.ts', import.meta.url),
    'utf8',
  );
  assert.match(dto, /@Min\(1[^)]*\)\s*\r?\n\s*productMaxDiscountAmount\?/, 'product cap minimum drifted from the DTO');
  assert.match(dto, /@Min\(1[^)]*\)\s*\r?\n\s*shippingMaxDiscountAmount\?/, 'shipping cap minimum drifted from the DTO');
});
