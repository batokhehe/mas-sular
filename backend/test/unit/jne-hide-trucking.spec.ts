/**
 * Round 57: JNE Trucking (JTR) is never offered to, nor selectable by, a customer.
 *
 * Fixtures are the real JNE RATE rows production returned on 2026-11-07 (Round 56 smoke) for
 * Gambir (CGK10302) and Coblong (BDO10054): trucking arrives as JTR23, JTR<130, JTR>130,
 * JTR>200 and the city-courier variant CTCJTR23.
 *
 * Real: PaxelProvider, JneProvider, ShippingService, ShippingProviderFactory, OrdersService.
 * Stubbed: both couriers' HTTP, the district -> JNE code lookup, Prisma. Offline.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import {
  JneProvider,
  isJneTruckingService,
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
    apiKey: 'trucking-fake-key',
    username: 'trucking-fake-user',
    originCode: 'BDO10000',
    timeoutMs: 500,
    maxRetry: 0,
  },
} as ShippingConfig;

const MAPPING: Record<string, string> = { 'dist-gambir': 'CGK10302', 'dist-coblong': 'BDO10054' };
const PAXEL_PRICES: Record<string, number> = {
  'INSTANT GOSEND': 44000,
  SAMEDAY: 23000,
  NEXTDAY: 23000,
  REGULAR: 15000,
};
const PAXEL_NO_CLUSTER = JSON.stringify({
  data: {},
  message: 'Corporate cluster price is not available (record not found)',
  status_code: 400,
});

const row = (code: string, display: string, price: unknown, dest = 'GAMBIR ,JAKARTA PUSAT') => ({
  origin_name: 'BANDUNG',
  destination_name: dest,
  service_display: display,
  service_code: code,
  goods_type: 'Document/Paket',
  currency: 'IDR',
  price,
  etd_from: '1',
  etd_thru: '2',
  times: 'D',
});
const body = (rows: unknown[]) => JSON.stringify({ price: rows });

/** Gambir, Jakarta Pusat: production RATE rows of 2026-11-07. */
const GAMBIR = body([
  row('JTR23', 'JTR', '45000'),
  row('JTR<130', 'JTR<130', '500000'),
  row('JTR>130', 'JTR>130', '850000'),
  row('JTR>200', 'JTR>200', '1200000'),
  row('REG23', 'REG', '13000'),
  row('SPS23', 'SPS', '228000'),
  row('YES23', 'YES', '17000'),
]);
/** Coblong, Bandung (intra-city): production RATE rows of 2026-11-07. */
const COBLONG = body(
  [
    row('CTC23', 'CTC', '9000'),
    row('CTCJTR23', 'JTR', '40000'),
    row('CTCSPS23', 'CTCSPS', '25000'),
    row('CTCYES23', 'CTCYES', '12000'),
    row('JTR<130', 'JTR<130', '200000'),
    row('JTR>130', 'JTR>130', '350000'),
    row('JTR>200', 'JTR>200', '500000'),
  ].map((r) => ({ ...r, destination_name: 'COBLONG,BANDUNG' })),
);

const TRUCKING_OBSERVED = ['JTR23', 'JTR<130', 'JTR>130', 'JTR>200', 'CTCJTR23'];

function world(jneBody: string, opts: { paxelRegularUnavailable?: boolean } = {}) {
  const paxelUrls: string[] = [];
  const paxel = new PaxelProvider(config);
  (paxel as unknown as { http: unknown }).http = async (url: string, init: ShippingHttpRequest) => {
    paxelUrls.push(url);
    const type = JSON.parse(init.body as string).service_type as string;
    if (type === 'REGULAR' && opts.paxelRegularUnavailable) {
      return { status: 400, text: async () => PAXEL_NO_CLUSTER, headers: { get: () => null } };
    }
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
  (jne as unknown as { http: unknown }).http = async () => ({
    status: 200,
    text: async () => jneBody,
    headers: { get: () => null },
  });
  return {
    shipping: new ShippingService(new ShippingProviderFactory([paxel, jne])),
    jne,
    paxelUrls,
  };
}

const request = (districtId = 'dist-gambir') => ({
  originPostalCode: '40111',
  destinationPostalCode: '10110',
  weightGram: 1000,
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
const jneOnly = (qs: Array<{ provider: string; service?: string; shippingCost: number }>) =>
  show(qs.filter((q) => q.provider === 'jne'));
const PAXEL_EXPECTED = [
  'paxel:PAXEL_SAMEDAY:23000',
  'paxel:PAXEL_NEXTDAY:23000',
  'paxel:PAXEL_REGULAR:15000',
];

beforeAll(() => Logger.overrideLogger(false));
afterEach(() => jest.restoreAllMocks());

describe('isJneTruckingService: identified by service_code', () => {
  it.each([...TRUCKING_OBSERVED, ' JTR23 ', 'jtr23', 'JTR25', 'JTR>300', 'CTCJTR25'])(
    '%s is JNE Trucking',
    (code) => {
      expect(isJneTruckingService(code)).toBe(true);
    },
  );

  it.each([
    'REG23',
    'YES23',
    'OKE23',
    'SPS23',
    'CTC23',
    'CTCYES23',
    'CTCSPS23',
    'REG19',
    'REG15',
    'XJTR23',
    'REGJTR',
    '',
  ])('%s is not JNE Trucking', (code) => {
    expect(isJneTruckingService(code)).toBe(false);
  });
});

describe('JneProvider: JTR never reaches a quote', () => {
  it('Gambir (real rows): JTR23, JTR<130, JTR>130, JTR>200 hidden; REG23, SPS23, YES23 offered', async () => {
    const { shipping } = world(GAMBIR);
    expect(jneOnly(await shipping.getQuotes(request('dist-gambir')))).toEqual([
      'jne:REG23:13000',
      'jne:SPS23:228000',
      'jne:YES23:17000',
    ]);
  });

  it('Coblong (real rows): CTCJTR23 and the JTR weight bands hidden; CTC23, CTCSPS23, CTCYES23 offered', async () => {
    const { shipping } = world(COBLONG);
    expect(jneOnly(await shipping.getQuotes(request('dist-coblong')))).toEqual([
      'jne:CTC23:9000',
      'jne:CTCSPS23:25000',
      'jne:CTCYES23:12000',
    ]);
  });

  it.each(TRUCKING_OBSERVED)('%s stays hidden even with a valid IDR price', async (code) => {
    const { shipping } = world(body([row(code, 'JTR', '45000')]));
    const quotes = await shipping.getQuotes(request());
    expect(quotes.some((q) => q.provider === 'jne')).toBe(false);
    expect(show(quotes)).toEqual(PAXEL_EXPECTED);
  });

  it.each([
    ['zero', '0'],
    ['empty', ''],
    ['hex', '0x2710'],
    ['null', null],
  ])('JTR with a %s price stays hidden', async (_l, price) => {
    const { shipping } = world(body([row('JTR23', 'JTR', price), row('REG23', 'REG', '13000')]));
    expect(jneOnly(await shipping.getQuotes(request()))).toEqual(['jne:REG23:13000']);
  });

  it('REG23, YES23, OKE23 and CTC23 are offered when valid', async () => {
    const { shipping } = world(
      body([
        row('REG23', 'REG', '13000'),
        row('YES23', 'YES', '17000'),
        row('OKE23', 'OKE', '11000'),
        row('CTC23', 'CTC', '9000'),
      ]),
    );
    expect(jneOnly(await shipping.getQuotes(request()))).toEqual([
      'jne:REG23:13000',
      'jne:YES23:17000',
      'jne:OKE23:11000',
      'jne:CTC23:9000',
    ]);
  });

  it('Round 39 price validation still applies to the non-trucking services', async () => {
    const { shipping } = world(
      body([
        row('REG23', 'REG', '0'),
        row('YES23', 'YES', ''),
        row('OKE23', 'OKE', '0x10'),
        { ...row('SPS23', 'SPS', '20000'), currency: 'USD' },
        row('CTC23', 'CTC', '9000'),
        row('JTR23', 'JTR', '45000'),
      ]),
    );
    expect(jneOnly(await shipping.getQuotes(request()))).toEqual(['jne:CTC23:9000']);
    for (const raw of ['0', '', '0x10']) expect(parseJnePrice(raw)).toBeNull();
  });

  it('hiding JTR on a normal response logs nothing (it is policy, not a data problem)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { shipping } = world(GAMBIR);
    await shipping.getQuotes(request());
    expect(
      warn.mock.calls.filter(([m]) => (m as { provider?: string }).provider === 'jne'),
    ).toEqual([]);
  });

  it('a destination with only JTR logs once that hiding left no JNE option, with codes only', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { shipping } = world(
      body([row('JTR23', 'JTR', '45000'), row('JTR<130', 'JTR<130', '500000')]),
    );
    await shipping.getQuotes(request());
    const jneWarns = warn.mock.calls
      .map(([m]) => m as Record<string, unknown>)
      .filter((m) => m.provider === 'jne');
    expect(jneWarns).toEqual([
      expect.objectContaining({
        outcome: 'unavailable',
        reason: 'jne_only_hidden_services',
        dropped: {},
        droppedServices: [],
        hiddenServices: ['JTR23', 'JTR<130'],
        kept: 0,
      }),
    ]);
    expect(JSON.stringify(jneWarns)).not.toContain('45000');
  });

  it('a JTR row with a bad price is reported as hidden, not as a dropped price', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { shipping } = world(
      body([row('JTR23', 'JTR', '0'), row('YES23', 'YES', '0'), row('REG23', 'REG', '13000')]),
    );
    await shipping.getQuotes(request());
    const [m] = warn.mock.calls
      .map(([x]) => x as Record<string, unknown>)
      .filter((x) => x.provider === 'jne');
    expect(m).toMatchObject({
      reason: 'jne_rows_dropped',
      dropped: { invalid_price: 1 },
      droppedServices: ['YES23'],
      hiddenServices: ['JTR23'],
      kept: 1,
    });
  });
});

describe('checkout: JTR cannot be selected, even by a manipulated request', () => {
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
  const PERSIST_REACHED = new Error('persist reached');
  const orders = (jneBody = GAMBIR, opts: { paxelRegularUnavailable?: boolean } = {}) => {
    const { shipping } = world(jneBody, opts);
    const prisma = {
      address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
      product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
      topping: { findMany: jest.fn().mockResolvedValue([]) },
      outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
      promo: { findFirst: jest.fn().mockResolvedValue(null) },
      order: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
      // Order persistence opens a transaction; reaching it means every gate passed.
      $transaction: jest.fn().mockRejectedValue(PERSIST_REACHED),
    };
    const svc = new OrdersService(
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
    return { svc, prisma };
  };
  const dto = (over: Record<string, unknown> = {}) => ({
    address_id: 'addr-1',
    courier: 'jne',
    shipping_provider: 'jne',
    shipping_service: 'REG23',
    items: [{ product_id: 'p1', qty: 1 }],
    ...over,
  });

  it('shipping options: Paxel and the non-trucking JNE services, no JTR, same option shape', async () => {
    const options = await orders().svc.getShippingOptions('u1', dto() as never);
    expect(show(options)).toEqual([
      ...PAXEL_EXPECTED,
      'jne:REG23:13000',
      'jne:SPS23:228000',
      'jne:YES23:17000',
    ]);
    for (const o of options) {
      expect(Object.keys(o)).toEqual(
        expect.arrayContaining([
          'provider',
          'service',
          'serviceName',
          'estimatedDays',
          'shippingCost',
        ]),
      );
      expect(Number.isInteger(o.shippingCost) && o.shippingCost > 0).toBe(true);
    }
  });

  it.each(TRUCKING_OBSERVED)('summary with a manually posted %s is refused', async (code) => {
    const body = code === 'CTCJTR23' ? COBLONG : GAMBIR;
    const promise = orders(body).svc.getSummary('u1', dto({ shipping_service: code }) as never);
    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      orders(body).svc.getSummary('u1', dto({ shipping_service: code }) as never),
    ).rejects.toThrow('Selected shipping service is unavailable');
  });

  it('placing an order with a manually posted JTR23 is refused before any order is written', async () => {
    const { svc, prisma } = orders();
    await expect(svc.checkout('u1', dto({ shipping_service: 'JTR23' }) as never)).rejects.toThrow(
      'Selected shipping service is unavailable',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('a valid JNE service is still selectable: summary priced, and checkout reaches order persistence', async () => {
    await expect(
      orders().svc.getSummary('u1', dto({ shipping_service: 'YES23' }) as never),
    ).resolves.toMatchObject({
      shipping_cost: 17000,
      delivery_fee: 17000,
      grand_total: 62000,
    });
    const { svc, prisma } = orders();
    await expect(svc.checkout('u1', dto() as never)).rejects.toBe(PERSIST_REACHED);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('courier-only request (no service posted) gets the first non-trucking JNE service, never JTR23', async () => {
    const s = await orders().svc.getSummary(
      'u1',
      dto({ shipping_provider: undefined, shipping_service: undefined }) as never,
    );
    expect(s).toMatchObject({ shipping_cost: 13000 });
  });
});

describe('Paxel is unaffected', () => {
  it('SAMEDAY and NEXTDAY offered, INSTANT GOSEND hidden and never requested', async () => {
    const { shipping, paxelUrls } = world(GAMBIR);
    const quotes = await shipping.getQuotes(request());
    expect(show(quotes.filter((q) => q.provider === 'paxel'))).toEqual(PAXEL_EXPECTED);
    expect(quotes.map((q) => q.service)).not.toContain('PAXEL_INSTANT');
    expect(paxelUrls.filter((u) => u.endsWith('/rates/instant'))).toEqual([]);
    await expect(shipping.findQuote(request(), 'paxel', 'PAXEL_INSTANT')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('REGULAR follows Paxel pricing coverage: absent when Paxel has no cluster price, SAMEDAY/NEXTDAY and JNE unaffected', async () => {
    const { shipping } = world(GAMBIR, { paxelRegularUnavailable: true });
    expect(show(await shipping.getQuotes(request()))).toEqual([
      'paxel:PAXEL_SAMEDAY:23000',
      'paxel:PAXEL_NEXTDAY:23000',
      'jne:REG23:13000',
      'jne:SPS23:228000',
      'jne:YES23:17000',
    ]);
  });

  it('Paxel prices are identical whether or not JNE returned trucking rows', async () => {
    const withJtr = show(
      (await world(GAMBIR).shipping.getQuotes(request())).filter((q) => q.provider === 'paxel'),
    );
    const withoutJtr = show(
      (await world(body([row('REG23', 'REG', '13000')])).shipping.getQuotes(request())).filter(
        (q) => q.provider === 'paxel',
      ),
    );
    expect(withJtr).toEqual(withoutJtr);
  });
});
