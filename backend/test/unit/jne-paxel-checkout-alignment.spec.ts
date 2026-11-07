/**
 * Round 55: JNE price validation (Round 39 parseJnePrice) in the REAL customer checkout path,
 * next to the REAL PaxelProvider as production configures it (INSTANT GOSEND hidden, e191e52).
 *
 * Real: PaxelProvider, JneProvider, ShippingService, ShippingProviderFactory, OrdersService
 * (getShippingOptions, getSummary with voucher discounts). Stubbed: the two couriers' HTTP, the
 * district -> JNE code lookup (a fixed map standing in for the mapping table) and Prisma reads.
 * Offline: the backend's no-external-network setup file is active.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { VoucherType } from '@prisma/client';
import {
  JneProvider,
  parseJnePrice,
} from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { OrdersService } from '../../src/modules/orders/orders.service';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingHttpRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';

const config = {
  allowMockRates: false,
  rajaongkir: {
    enabled: false,
    baseUrl: 'https://rajaongkir.invalid/api/v1',
    timeoutMs: 1000,
    maxRetry: 1,
  },
  paxel: {
    enabled: true,
    baseUrl: 'https://stage-commerce-api.paxel.test/v1',
    apiKey: 'test-api-key-not-a-real-secret',
    timeoutMs: 500,
    maxRetry: 0,
    defaultDimension: '30x35x20',
    needInsurance: false,
  },
  jne: {
    enabled: true,
    environment: 'sandbox',
    baseUrl: 'https://jne-pricing.test',
    apiKey: 'alignment-fake-key',
    username: 'alignment-fake-user',
    originCode: 'BDO10000',
    timeoutMs: 500,
    maxRetry: 0,
  },
} as ShippingConfig;

const MAPPING: Record<string, string> = { 'dist-gambir': 'CGK10302', 'dist-coblong': 'BDO10054' };
const PAXEL_PRICES: Record<string, number> = {
  'INSTANT GOSEND': 44000,
  SAMEDAY: 25000,
  NEXTDAY: 18000,
  REGULAR: 15000,
};
const PAXEL_EXPECTED = [
  'paxel:PAXEL_SAMEDAY:25000',
  'paxel:PAXEL_NEXTDAY:18000',
  'paxel:PAXEL_REGULAR:15000',
];
const row = (service: string, price: string, extra = '"currency":"IDR"') =>
  `{"service_code":"${service}","service_display":"${service}",${extra ? `${extra},` : ''}"etd_from":"1","etd_thru":"2","price":${price}}`;

function world(jneBody: string) {
  const paxelUrls: string[] = [];
  const jneSent: string[] = [];
  const paxel = new PaxelProvider(config);
  (paxel as unknown as { http: unknown }).http = async (url: string, init: ShippingHttpRequest) => {
    paxelUrls.push(url);
    const type = JSON.parse(init.body as string).service_type as string;
    return {
      status: 200,
      text: async () =>
        JSON.stringify({ data: { fixed_price: PAXEL_PRICES[type], time_detail: [] } }),
      headers: { get: () => null },
    };
  };
  const jne = new JneProvider(config, {
    resolve: async (id?: string) => (id ? (MAPPING[id] ?? null) : null),
  } as never);
  (jne as unknown as { http: unknown }).http = async (_url: string, init: ShippingHttpRequest) => {
    jneSent.push(new URLSearchParams(init.body as string).get('thru') ?? '');
    return { status: 200, text: async () => jneBody, headers: { get: () => null } };
  };
  return {
    shipping: new ShippingService(new ShippingProviderFactory([paxel, jne])),
    paxelUrls,
    jneSent,
  };
}

const request = (districtId?: string) => ({
  originPostalCode: '40111',
  destinationPostalCode: '10110',
  weightGram: 1200,
  destinationDistrictId: districtId,
  originAddress: 'Jl. Outlet 1',
  originProvince: 'Jawa Barat',
  originCity: 'Kota Bandung',
  originDistrict: 'Coblong',
  destinationAddress: 'Jl. Tujuan 2',
  destinationProvince: 'DKI Jakarta',
  destinationCity: 'Jakarta Pusat',
  destinationDistrict: 'Gambir',
});
const show = (qs: Array<{ provider: string; service?: string; shippingCost: number }>) =>
  qs.map((q) => `${q.provider}:${q.service}:${q.shippingCost}`);

beforeAll(() => Logger.overrideLogger(false));

describe('Round 39 price rule as used by the checkout JNE provider', () => {
  it.each([
    ['valid positive IDR price', '"18000"', 18000],
    ['valid positive JSON number', '18000', 18000],
  ])('%s is offered', async (_l, price, cost) => {
    const { shipping } = world(`{"price":[${row('REG23', price)}]}`);
    expect(show(await shipping.getQuotes(request('dist-gambir')))).toEqual([
      ...PAXEL_EXPECTED,
      `jne:REG23:${cost}`,
    ]);
  });

  it.each([
    ['zero', '"0"'],
    ['numeric zero', '0'],
    ['negative', '"-1000"'],
    ['empty', '""'],
    ['blank', '"   "'],
    ['null', 'null'],
    ['malformed numeric', '"18.000,00"'],
    ['hexadecimal', '"0x4650"'],
    ['rounds to zero', '"0.4"'],
    ['exponent string', '"1e4"'],
  ])('a %s price is never offered; Paxel is unaffected', async (_l, price) => {
    const { shipping } = world(`{"price":[${row('REG23', price)}]}`);
    expect(show(await shipping.getQuotes(request('dist-gambir')))).toEqual(PAXEL_EXPECTED);
  });

  it.each([
    ['USD', '"currency":"USD"'],
    ['empty currency', '"currency":""'],
    ['numeric currency', '"currency":360'],
  ])('a valid amount in %s is never offered', async (_l, currency) => {
    const { shipping } = world(`{"price":[${row('REG23', '"18000"', currency)}]}`);
    expect(show(await shipping.getQuotes(request('dist-gambir')))).toEqual(PAXEL_EXPECTED);
  });

  it('mixed services: each invalid row is dropped on its own, every valid one is kept', async () => {
    const body = `{"price":[${row('OKE23', '"0"')},${row('REG23', '"18000"')},null,${row('YES23', '"9000"', '"currency":"USD"')},${row('CTC23', '"60000"')},${row('SPS23', '""')}]}`;
    const { shipping } = world(body);
    expect(show(await shipping.getQuotes(request('dist-gambir')))).toEqual([
      ...PAXEL_EXPECTED,
      'jne:REG23:18000',
      'jne:CTC23:60000',
    ]);
  });

  it('all services invalid: no JNE option at all, Paxel still offered', async () => {
    const { shipping } = world(
      `{"price":[${row('OKE23', '"0"')},${row('REG23', '""')},${row('YES23', 'null')}]}`,
    );
    const quotes = await shipping.getQuotes(request('dist-gambir'));
    expect(quotes.some((q) => q.provider === 'jne')).toBe(false);
    expect(show(quotes)).toEqual(PAXEL_EXPECTED);
  });

  it('the checkout rule is exactly parseJnePrice (no second implementation)', () => {
    for (const raw of [
      '18000',
      18000,
      '0',
      0,
      '',
      '   ',
      null,
      '-1',
      '0x10',
      '0.4',
      '1e4',
      ' 18000 ',
      '18000.5',
    ]) {
      const expected = parseJnePrice(raw);
      expect(expected === null || (Number.isInteger(expected) && expected >= 1)).toBe(true);
    }
  });
});

describe('destination resolver and Paxel behaviour in the same checkout', () => {
  it('JNE is asked with the mapped code of the customer district only', async () => {
    const { shipping, jneSent } = world(`{"price":[${row('REG23', '"18000"')}]}`);
    await shipping.getQuotes(request('dist-gambir'));
    await shipping.getQuotes(request('dist-coblong'));
    await shipping.getQuotes(request('dist-unmapped'));
    await shipping.getQuotes(request(undefined));
    expect(jneSent).toEqual(['CGK10302', 'BDO10054']);
  });

  it('Paxel INSTANT GOSEND stays hidden (production config) and is never requested; REGULAR is offered', async () => {
    const { shipping, paxelUrls } = world(`{"price":[${row('REG23', '"18000"')}]}`);
    const quotes = await shipping.getQuotes(request('dist-gambir'));
    expect(quotes.map((q) => q.service)).not.toContain('PAXEL_INSTANT');
    expect(paxelUrls.filter((u) => u.endsWith('/rates/instant'))).toEqual([]);
    await expect(
      shipping.findQuote(request('dist-gambir'), 'paxel', 'PAXEL_INSTANT'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      shipping.findQuote(request('dist-gambir'), 'paxel', 'PAXEL_REGULAR'),
    ).resolves.toMatchObject({ shippingCost: 15000 });
  });

  it('Paxel prices are identical whatever JNE returns (valid, invalid, malformed, unavailable)', async () => {
    const bodies = [
      `{"price":[${row('REG23', '"18000"')}]}`,
      `{"price":[${row('REG23', '"0"')}]}`,
      '{"price":[null]}',
      'not json',
      '{"status":false,"error":"Price Not Found"}',
    ];
    for (const body of bodies) {
      const { shipping } = world(body);
      expect(
        show(
          (await shipping.getQuotes(request('dist-gambir'))).filter((q) => q.provider === 'paxel'),
        ),
      ).toEqual(PAXEL_EXPECTED);
    }
  });
});

describe('OrdersService checkout: options, response contract and voucher discounts', () => {
  const PRODUCT = {
    id: 'p1',
    name: 'Bakso',
    price: 45000,
    stock: 10,
    status: 'ACTIVE',
    deletedAt: null,
    weightGram: 800,
  };
  const ADDRESS = {
    id: 'addr-1',
    userId: 'u1',
    deletedAt: null,
    provinceId: 'prov',
    cityId: 'city',
    districtId: 'dist-gambir',
    villageId: 'vil',
    postalCode: '10110',
    latitude: -6.17,
    longitude: 106.82,
    fullAddress: 'Jl. Tujuan 2',
    addressDetail: null,
    province: { name: 'DKI Jakarta' },
    city: { name: 'Jakarta Pusat' },
    district: { name: 'Gambir' },
    village: { name: 'Gambir' },
  };
  const OUTLET = {
    id: 'o1',
    name: 'Pusat',
    postalCode: '40111',
    latitude: -6.91,
    longitude: 107.6,
    addressDetail: 'Jl. Outlet 1',
    province: { name: 'Jawa Barat' },
    city: { name: 'Kota Bandung' },
    district: { name: 'Coblong' },
    village: { name: 'Dago' },
  };
  const voucher = (over: Record<string, unknown>) => ({
    id: 'v1',
    code: 'ONGKIR',
    isActive: true,
    startDate: null,
    endDate: null,
    maxUsageCount: null,
    currentUsageCount: 0,
    minimumOrderAmount: 0,
    isNewUserOnly: false,
    freeShippingMaxAmount: null,
    discountPercentage: null,
    maxDiscountAmount: null,
    discountAmount: null,
    deletedAt: null,
    ...over,
  });
  const orders = (jneBody: string, promo: Record<string, unknown> | null = null) => {
    const { shipping } = world(jneBody);
    const prisma = {
      address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
      product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
      topping: { findMany: jest.fn().mockResolvedValue([]) },
      outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
      promo: { findFirst: jest.fn().mockResolvedValue(promo) },
      order: { count: jest.fn().mockResolvedValue(0) },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    return new OrdersService(
      prisma as never,
      shipping,
      { isCheckoutEnabled: () => false } as never,
      { issue: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: false } as never,
    );
  };
  const dto = (over: Record<string, unknown> = {}) => ({
    address_id: 'addr-1',
    courier: 'jne',
    shipping_provider: 'jne',
    shipping_service: 'REG23',
    items: [{ product_id: 'p1', qty: 1 }],
    ...over,
  });
  const MIXED = `{"price":[${row('OKE23', '"0"')},${row('REG23', '"18000"')},${row('YES23', '"9000"', '"currency":"USD"')}]}`;

  it('shipping options: Paxel and the valid JNE service together; invalid JNE rows absent', async () => {
    const options = await orders(MIXED).getShippingOptions('u1', dto() as never);
    expect(show(options)).toEqual([...PAXEL_EXPECTED, 'jne:REG23:18000']);
  });

  it('response contract: every option keeps provider, service, serviceName, estimatedDays and an integer shippingCost', async () => {
    const options = await orders(MIXED).getShippingOptions('u1', dto() as never);
    for (const o of options) {
      expect(Object.keys(o).sort()).toEqual(
        expect.arrayContaining([
          'estimatedDays',
          'provider',
          'service',
          'serviceName',
          'shippingCost',
        ]),
      );
      expect(Number.isInteger(o.shippingCost) && o.shippingCost > 0).toBe(true);
    }
  });

  it('all JNE services invalid: only Paxel options, and a JNE selection is refused (never charged Rp0)', async () => {
    const svc = orders(`{"price":[${row('REG23', '"0"')}]}`);
    expect(show(await svc.getShippingOptions('u1', dto() as never))).toEqual(PAXEL_EXPECTED);
    await expect(svc.getSummary('u1', dto() as never)).rejects.toThrow(
      'Selected shipping service is unavailable',
    );
  });

  it('summary with JNE: delivery fee is the validated JNE price', async () => {
    const s = await orders(MIXED).getSummary('u1', dto() as never);
    expect(s).toMatchObject({
      subtotal: 45000,
      shipping_cost: 18000,
      delivery_fee: 18000,
      discount: 0,
      grand_total: 63000,
    });
  });

  it('summary with Paxel REGULAR: unchanged Paxel price', async () => {
    const s = await orders(MIXED).getSummary(
      'u1',
      dto({
        courier: 'paxel',
        shipping_provider: 'paxel',
        shipping_service: 'PAXEL_REGULAR',
      }) as never,
    );
    expect(s).toMatchObject({ shipping_cost: 15000, grand_total: 60000 });
  });

  it('free-shipping voucher discounts the validated JNE price (capped) and the Paxel price', async () => {
    const free = voucher({ voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: 10000 });
    await expect(
      orders(MIXED, free).getSummary('u1', dto({ voucher_code: 'ongkir' }) as never),
    ).resolves.toMatchObject({ delivery_fee: 18000, discount: 10000, grand_total: 53000 });
    await expect(
      orders(MIXED, free).getSummary(
        'u1',
        dto({
          voucher_code: 'ongkir',
          courier: 'paxel',
          shipping_provider: 'paxel',
          shipping_service: 'PAXEL_REGULAR',
        }) as never,
      ),
    ).resolves.toMatchObject({ delivery_fee: 15000, discount: 10000, grand_total: 50000 });
  });

  it('percentage voucher applies to the subtotal only, with JNE shipping unchanged', async () => {
    const pct = voucher({
      voucherType: VoucherType.PERCENTAGE_DISCOUNT,
      discountPercentage: 10,
      maxDiscountAmount: null,
    });
    await expect(
      orders(MIXED, pct).getSummary('u1', dto({ voucher_code: 'ongkir' }) as never),
    ).resolves.toMatchObject({ delivery_fee: 18000, discount: 4500, grand_total: 58500 });
  });
});
