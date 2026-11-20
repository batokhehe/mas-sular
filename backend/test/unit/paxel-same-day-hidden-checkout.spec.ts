import { BadRequestException, Logger } from '@nestjs/common';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { CHECKOUT_WITHHELD_SERVICES, checkoutQuotes, isOfferedAtCheckout } from '../../src/modules/shipping/checkout-offer.policy';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingHttpRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import type { ShippingProvider, ShippingQuote } from '../../src/modules/shipping/domain/shipping-provider.interface';

/**
 * Paxel Same Day is hidden from CUSTOMERS only (2026-11-20).
 *
 * Identifier verified against production orders/shipments: provider `paxel`,
 * service `PAXEL_SAMEDAY` (Paxel service_type `SAMEDAY` on /rates/city).
 * The provider still quotes it and ShippingService.getQuotes still returns it
 * (allocation, admin booking and existing orders are unchanged); the checkout
 * options, selection and the courier-only fallback never offer it.
 *
 * Real: PaxelProvider (HTTP stubbed), ShippingService, ShippingProviderFactory, OrdersService.
 * Stubbed: JNE (fixed quotes), Prisma. Offline.
 */

const config = {
  allowMockRates: false,
  rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 1 },
  paxel: {
    enabled: true,
    baseUrl: 'https://stage-commerce-api.paxel.test/v1',
    apiKey: 'test-api-key-not-a-real-secret',
    timeoutMs: 500,
    maxRetry: 0,
    defaultDimension: '30x35x20',
    needInsurance: false,
  },
  jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
} as ShippingConfig;

const PAXEL_PRICES: Record<string, number> = { SAMEDAY: 25000, NEXTDAY: 18000, REGULAR: 15000 };
const JNE_QUOTES: ShippingQuote[] = [
  { provider: 'jne', service: 'REG23', serviceName: 'JNE REG', estimatedDays: '2-3', shippingCost: 13000 },
  { provider: 'jne', service: 'YES23', serviceName: 'JNE YES', estimatedDays: '1', shippingCost: 17000 },
];

function world() {
  const paxelServiceTypes: string[] = [];
  const paxel = new PaxelProvider(config);
  (paxel as unknown as { http: unknown }).http = async (_url: string, init: ShippingHttpRequest) => {
    const serviceType = JSON.parse(init.body as string).service_type as string;
    paxelServiceTypes.push(serviceType);
    return {
      status: 200,
      text: async () => JSON.stringify({ data: { fixed_price: PAXEL_PRICES[serviceType], time_detail: [] } }),
      headers: { get: () => null },
    };
  };
  const jne: ShippingProvider = {
    name: 'jne',
    getRates: async () => JNE_QUOTES.map((q) => ({ ...q })),
    track: async (trackingNumber: string) => ({ provider: 'jne', trackingNumber, status: 'OK', history: [] }),
  };
  const shipping = new ShippingService(new ShippingProviderFactory([paxel, jne]));
  return { shipping, paxelServiceTypes };
}

const PRODUCT = { id: 'p1', name: 'Bakso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 800 };
const ADDRESS = {
  id: 'addr-1', userId: 'u1', deletedAt: null, provinceId: 'prov', cityId: 'city', districtId: 'dist', villageId: 'vil',
  postalCode: '40132', latitude: -6.9, longitude: 107.6, fullAddress: 'Jl. Tujuan 2',
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Sukasari' }, village: { name: 'Isola' },
};
const OUTLET = {
  id: 'o1', name: 'Pusat', postalCode: '40111', latitude: -6.91, longitude: 107.6, addressDetail: 'Jl. Outlet 1',
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Coblong' }, village: { name: 'Dago' },
};
const PERSIST_REACHED = new Error('persist reached');

function orders() {
  const { shipping, paxelServiceTypes } = world();
  const prisma = {
    address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    // Order persistence opens a transaction; reaching it means every gate passed.
    $transaction: jest.fn().mockRejectedValue(PERSIST_REACHED),
  };
  const svc = new OrdersService(
    prisma as never,
    shipping,
    { isCheckoutEnabled: () => false } as never,
    { issue: jest.fn() } as never,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { enabled: false } as never,
  );
  return { svc, prisma, shipping, paxelServiceTypes };
}

const dto = (over: Record<string, unknown> = {}) => ({
  address_id: 'addr-1',
  courier: 'paxel',
  shipping_provider: 'paxel',
  shipping_service: 'PAXEL_NEXTDAY',
  items: [{ product_id: 'p1', qty: 1 }],
  ...over,
});
const show = (qs: Array<{ provider: string; service?: string; shippingCost: number }>) => qs.map((q) => `${q.provider}:${q.service}:${q.shippingCost}`);

beforeAll(() => Logger.overrideLogger(false));

describe('checkout offer policy', () => {
  it('withholds exactly Paxel Same Day', () => {
    expect(CHECKOUT_WITHHELD_SERVICES.map((s) => `${s.provider}:${s.service}`)).toEqual(['paxel:PAXEL_SAMEDAY']);
    expect(isOfferedAtCheckout({ provider: 'paxel', service: 'PAXEL_SAMEDAY' })).toBe(false);
    expect(isOfferedAtCheckout({ provider: 'Paxel', service: ' paxel_sameday ' })).toBe(false);
    for (const service of ['PAXEL_NEXTDAY', 'PAXEL_REGULAR', 'PAXEL_INSTANT']) {
      expect(isOfferedAtCheckout({ provider: 'paxel', service })).toBe(true);
    }
    // Another courier's code is never matched by the Paxel entry.
    expect(isOfferedAtCheckout({ provider: 'jne', service: 'PAXEL_SAMEDAY' })).toBe(true);
    expect(checkoutQuotes(JNE_QUOTES)).toEqual(JNE_QUOTES);
  });
});

describe('rate retrieval and the integration layer are unchanged', () => {
  it('Paxel is still asked for SAMEDAY, and getQuotes still returns it with every other service', async () => {
    const { shipping, paxelServiceTypes } = world();
    const quotes = await shipping.getQuotes({
      originPostalCode: '40111',
      destinationPostalCode: '40132',
      weightGram: 800,
      originAddress: 'Jl. Outlet 1',
      originProvince: 'Jawa Barat',
      originCity: 'Kota Bandung',
      originDistrict: 'Coblong',
      destinationAddress: 'Jl. Tujuan 2',
      destinationProvince: 'Jawa Barat',
      destinationCity: 'Kota Bandung',
      destinationDistrict: 'Sukasari',
    });
    expect(paxelServiceTypes.sort()).toEqual(['NEXTDAY', 'REGULAR', 'SAMEDAY']);
    expect(show(quotes)).toEqual([
      'paxel:PAXEL_SAMEDAY:25000',
      'paxel:PAXEL_NEXTDAY:18000',
      'paxel:PAXEL_REGULAR:15000',
      'jne:REG23:13000',
      'jne:YES23:17000',
    ]);
  });
});

describe('customer checkout', () => {
  it('shipping options hide Paxel Same Day; other Paxel services and JNE are unchanged (same order, same prices)', async () => {
    const { svc, paxelServiceTypes } = orders();
    const options = await svc.getShippingOptions('u1', dto() as never);
    expect(show(options)).toEqual(['paxel:PAXEL_NEXTDAY:18000', 'paxel:PAXEL_REGULAR:15000', 'jne:REG23:13000', 'jne:YES23:17000']);
    // Rates were still retrieved for Same Day - only the customer list drops it.
    expect(paxelServiceTypes).toContain('SAMEDAY');
  });

  it('a summary naming PAXEL_SAMEDAY (stale client or crafted request) is refused', async () => {
    const { svc } = orders();
    await expect(svc.getSummary('u1', dto({ shipping_service: 'PAXEL_SAMEDAY' }) as never)).rejects.toThrow(
      new BadRequestException('Selected shipping service is unavailable'),
    );
  });

  it('placing an order on PAXEL_SAMEDAY is refused before anything is written', async () => {
    const { svc, prisma } = orders();
    await expect(svc.checkout('u1', dto({ shipping_service: 'PAXEL_SAMEDAY' }) as never)).rejects.toThrow(
      'Selected shipping service is unavailable',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it.each([
    ['PAXEL_NEXTDAY', 18000],
    ['PAXEL_REGULAR', 15000],
  ])('%s stays selectable at its quoted price, and checkout reaches order persistence', async (service, price) => {
    const { svc, prisma } = orders();
    await expect(svc.getSummary('u1', dto({ shipping_service: service }) as never)).resolves.toMatchObject({ shipping_cost: price });
    await expect(svc.checkout('u1', dto({ shipping_service: service }) as never)).rejects.toBe(PERSIST_REACHED);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('JNE selection is unchanged', async () => {
    const { svc } = orders();
    await expect(
      svc.getSummary('u1', dto({ courier: 'jne', shipping_provider: 'jne', shipping_service: 'YES23' }) as never),
    ).resolves.toMatchObject({ shipping_cost: 17000 });
  });

  it('courier-only fallback (no service named) picks the first OFFERED Paxel service, never Same Day', async () => {
    const { svc } = orders();
    const summary = await svc.getSummary('u1', dto({ shipping_provider: undefined, shipping_service: undefined }) as never);
    expect(summary).toMatchObject({ shipping_cost: 18000 });
    await expect(svc.calculateShippingCost('u1', { address_id: 'addr-1', courier: 'paxel', items: [{ product_id: 'p1', qty: 1 }] } as never)).resolves.toMatchObject({
      shipping_cost: 18000,
    });
  });
});
