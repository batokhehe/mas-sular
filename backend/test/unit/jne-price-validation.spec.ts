/**
 * Round 39 (F1, F2) — a JNE price must be real before it can become a checkout option.
 *
 * F1: zero, empty and blank prices used to become selectable Rp0 options, because
 * `Number("")` is 0 and only negatives were rejected. F2: one malformed row (a null
 * entry, a non-string field) threw a TypeError that discarded every valid JNE service.
 *
 * Everything runs over a mocked transport: no JNE endpoint, no credential.
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { JneProvider, parseJnePrice } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { ShippingProviderFactory } from '../../src/modules/shipping/shipping-provider.factory';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import type { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import type { ShippingProvider, ShippingQuote, ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';

const FAKE_KEY = 'price-validation-fake-key';
const config = (): ShippingConfig =>
  ({
    allowMockRates: true,
    paxel: { enabled: false, baseUrl: 'https://paxel.test', timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false },
    jne: { enabled: true, environment: 'sandbox', baseUrl: 'https://jne-pricing.test', apiKey: FAKE_KEY, username: 'price-validation-user', originCode: 'BDO10000', timeoutMs: 500, maxRetry: 0 },
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.test', apiKey: 'unused', timeoutMs: 500, maxRetry: 0 },
  }) as ShippingConfig;
const res = (status: number, body: string): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });
const REG = '"service_code":"REG23","service_display":"REG","currency":"IDR","etd_from":"1","etd_thru":"2"';
/** Raw JSON text, so that `1e999` really arrives as Infinity. */
const oneRow = (price: string | null) => `{"price":[{${REG}${price === null ? '' : `,"price":${price}`}}]}`;

function jne(body?: string, code: string | null = 'CGK10209') {
  const http = jest.fn();
  if (body !== undefined) http.mockResolvedValue(res(200, body));
  const provider = new JneProvider(config(), { resolve: async () => code } as never);
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http };
}
const request = (over: Partial<ShippingRateRequest> = {}): ShippingRateRequest => ({
  originPostalCode: '40111', destinationPostalCode: '12810', weightGram: 1000, destinationDistrictId: 'dist-tebet', ...over,
});
const rates = (body: string) => jne(body).provider.getRates(request());

const PAXEL: ShippingQuote = { provider: 'paxel', service: 'PAXEL_INSTANT', serviceName: 'Paxel Instant', estimatedDays: 'Today', shippingCost: 44000 };
const paxel = (fail = false): ShippingProvider => ({
  name: 'paxel',
  getRates: async () => {
    if (fail) throw new TransientError('paxel down', 'paxel');
    return [{ ...PAXEL }];
  },
  track: async (n: string) => ({ provider: 'paxel', trackingNumber: n, status: 'OK', history: [] }),
});

beforeAll(() => Logger.overrideLogger(false));

describe('parseJnePrice', () => {
  it.each([
    ['string zero', '0'], ['numeric zero', 0], ['negative zero', -0], ['empty string', ''], ['whitespace', '   '], ['tab and newline', '\t\n'],
    ['null', null], ['undefined', undefined], ['negative number', -1], ['negative string', '-1'], ['non-numeric', 'abc'],
    ['thousands separator', '15,000'], ['currency prefix', 'Rp15000'], ['string NaN', 'NaN'], ['numeric NaN', NaN],
    ['string Infinity', 'Infinity'], ['numeric Infinity', Infinity], ['negative Infinity', -Infinity], ['hex', '0x10'],
    ['exponent string', '1e4'], ['rounds to zero (string)', '0.4'], ['rounds to zero (number)', 0.4], ['boolean', true],
    ['object', {}], ['array', [15000]],
  ])('rejects %s', (_label, raw) => {
    expect(parseJnePrice(raw)).toBeNull();
  });

  it.each([
    ['integer string', '15000', 15000], ['number', 15000, 15000], ['padded string', ' 15000 ', 15000],
    ['decimal string rounds half up', '15000.5', 15001], ['decimal number rounds down', 15000.4, 15000],
    ['smallest positive that rounds to Rp1', '0.5', 1], ['numeric exponent from JSON', 1e4, 10000],
  ])('accepts %s', (_label, raw, idr) => {
    expect(parseJnePrice(raw)).toBe(idr);
  });
});

describe('F1: an invalid price never becomes a quote', () => {
  it.each([
    ['"0"', '"0"'], ['0', '0'], ['""', '""'], ['"   "', '"   "'], ['null', 'null'], ['missing', null], ['-1', '-1'],
    ['"-5000"', '"-5000"'], ['"abc"', '"abc"'], ['"NaN"', '"NaN"'], ['"Infinity"', '"Infinity"'], ['1e999 (Infinity)', '1e999'],
    ['"0.4"', '"0.4"'], ['"0x10"', '"0x10"'],
  ])('price %s: no quote', async (_label, price) => {
    await expect(rates(oneRow(price))).resolves.toEqual([]);
  });

  it.each([
    ['"15000"', '"15000"', 15000], ['15000', '15000', 15000], ['"15000.5"', '"15000.5"', 15001],
  ])('price %s: one quote at Rp%#', async (_label, price, idr) => {
    const quotes = await rates(oneRow(price));
    expect(quotes.map((q) => [q.service, q.shippingCost])).toEqual([['REG23', idr]]);
  });

  it('a valid quote keeps its full contract (service, label, ETD, IDR integer, verbatim meta)', async () => {
    const [quote] = await rates(oneRow('"11000"'));
    expect(quote).toEqual({
      provider: 'jne', service: 'REG23', serviceName: 'REG', estimatedDays: '1-2', shippingCost: 11000,
      providerMeta: { service_code: 'REG23', service_display: 'REG', goods_type: null, currency: 'IDR', etd_from: '1', etd_thru: '2', times: null, origin_name: null, destination_name: null },
    });
  });
});

describe('currency is validated when JNE supplies it', () => {
  const withCurrency = (c: string) => `{"price":[{"service_code":"REG23","price":"12000"${c}}]}`;
  it.each([['IDR', ',"currency":"IDR"'], ['idr', ',"currency":"idr"'], [' IDR ', ',"currency":" IDR "'], ['null', ',"currency":null'], ['absent', '']])(
    'currency %s: accepted', async (_label, c) => {
      await expect(rates(withCurrency(c))).resolves.toHaveLength(1);
    },
  );
  it.each([['USD', ',"currency":"USD"'], ['empty', ',"currency":""'], ['number', ',"currency":360'], ['IDR2', ',"currency":"IDRX"']])(
    'currency %s: rejected', async (_label, c) => {
      await expect(rates(withCurrency(c))).resolves.toEqual([]);
    },
  );
});

describe('F2: a malformed row is dropped on its own; valid rows survive', () => {
  const valid = `{${REG},"price":"9000"}`;
  it.each([
    ['null row', 'null'], ['string row', '"x"'], ['array row', '[1]'], ['numeric service_code', '{"service_code":123,"price":"9000"}'],
    ['blank service_code', '{"service_code":"  ","price":"9000"}'], ['zero price', '{"service_code":"YES23","price":"0"}'],
    ['empty price', '{"service_code":"YES23","price":""}'], ['non-IDR', '{"service_code":"YES23","currency":"USD","price":"9"}'],
  ])('%s next to a valid row: only the valid row is quoted', async (_label, bad) => {
    const quotes = await rates(`{"price":[${bad},${valid}]}`);
    expect(quotes.map((q) => [q.service, q.shippingCost])).toEqual([['REG23', 9000]]);
  });

  it('non-string display and ETD fields no longer throw; the service is kept with a safe label and ETD', async () => {
    const quotes = await rates('{"price":[{"service_code":"OKE23","service_display":5,"etd_from":2,"etd_thru":null,"price":"8000"}]}');
    expect(quotes).toMatchObject([{ service: 'OKE23', serviceName: 'OKE23', estimatedDays: 'N/A', shippingCost: 8000 }]);
  });

  it('all rows malformed: no quote, no throw', async () => {
    await expect(rates('{"price":[null,{"service_code":"","price":"9000"},{"service_code":"YES23","price":"0"}]}')).resolves.toEqual([]);
  });

  it('logs one safe diagnostic: reasons, counts and service codes only (no payload price, no credential)', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await rates(`{"price":[null,{"service_code":"YES23","price":"0"},{"service_code":"JTR23","currency":"USD","price":"777"},${valid}]}`);
      const calls = warn.mock.calls.filter(([m]) => (m as { reason?: string }).reason === 'jne_rows_dropped');
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toEqual({
        provider: 'jne', outcome: 'partial', reason: 'jne_rows_dropped',
        dropped: { row_not_object: 1, invalid_price: 1, non_idr_currency: 1 }, droppedServices: ['YES23', 'JTR23'], kept: 1,
        origin: 'BDO10000', destination: 'CGK10209',
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('777');
    } finally {
      warn.mockRestore();
    }
  });

  it('when nothing survives, the diagnostic says so', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await rates(oneRow('"0"'));
      expect(warn.mock.calls.map(([m]) => (m as { reason?: string; outcome?: string })).filter((m) => m.reason === 'jne_no_valid_price_rows'))
        .toEqual([expect.objectContaining({ outcome: 'unavailable', kept: 0, dropped: { invalid_price: 1 } })]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('unchanged fail-closed behaviour', () => {
  it.each([['empty body', ''], ['empty price list', '{"price":[]}'], ['refusal', '{"status":false,"error":"Price Not Found."}'], ['no price key', '{}']])(
    '%s: no quote', async (_label, body) => {
      await expect(rates(body)).resolves.toEqual([]);
    },
  );
  it('timeout: TransientError', async () => {
    const { provider, http } = jne();
    http.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(provider.getRates(request())).rejects.toBeInstanceOf(TransientError);
  });
  it.each([[500, TransientError], [429, TransientError], [401, PermanentError]])('HTTP %i: classified error', async (status, cls) => {
    const { provider, http } = jne();
    http.mockResolvedValue(res(status as number, 'x'));
    await expect(provider.getRates(request())).rejects.toBeInstanceOf(cls);
  });
});

describe('courier isolation with price validation', () => {
  const world = (body: string, paxelFails = false) => {
    const { provider } = jne(body);
    return new ShippingService(new ShippingProviderFactory([paxel(paxelFails), provider]));
  };

  it('valid JNE + Paxel: both offered', async () => {
    const quotes = await world(oneRow('"11000"')).getQuotes(request());
    expect(quotes.map((q) => [q.provider, q.service, q.shippingCost])).toEqual([['paxel', 'PAXEL_INSTANT', 44000], ['jne', 'REG23', 11000]]);
  });

  it.each([['zero', '"0"'], ['empty', '""'], ['blank', '"  "']])('invalid JNE price (%s) + Paxel: only Paxel, unchanged', async (_label, price) => {
    await expect(world(oneRow(price)).getQuotes(request())).resolves.toEqual([PAXEL]);
  });

  it('malformed JNE row + Paxel: Paxel and the valid JNE row both survive', async () => {
    const quotes = await world(`{"price":[null,{${REG},"price":"9000"}]}`).getQuotes(request());
    expect(quotes.map((q) => `${q.provider}:${q.service}`)).toEqual(['paxel:PAXEL_INSTANT', 'jne:REG23']);
  });

  it('a JNE service with an invalid price cannot be selected (server-authoritative price)', async () => {
    const svc = world(oneRow('"0"'));
    await expect(svc.findQuote(request(), 'jne', 'REG23')).rejects.toThrow('Selected shipping service is unavailable');
    expect((await svc.calculateRates(request())).map((r) => r.provider)).toEqual(['paxel']);
  });

  it('every offered option has a positive integer price, across a mixed response', async () => {
    const body = `{"price":[{"service_code":"A","price":"0"},{"service_code":"B","price":""},{"service_code":"C","price":"   "},{"service_code":"D","price":null},{"service_code":"E","price":"-1"},{"service_code":"F","price":"12000"}]}`;
    const quotes = await world(body).getQuotes(request());
    expect(quotes.every((q) => Number.isInteger(q.shippingCost) && q.shippingCost > 0)).toBe(true);
    expect(quotes.map((q) => q.service)).toEqual(['PAXEL_INSTANT', 'F']);
  });
});

describe('checkout (OrdersService) never shows or charges an invalid JNE price', () => {
  const PRODUCT = { id: 'p1', name: 'Bakso', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 800 };
  const ADDRESS = {
    id: 'addr-1', userId: 'u1', deletedAt: null, provinceId: 'prov', cityId: 'city', districtId: 'dist-tebet', villageId: 'vil', postalCode: '12810',
    latitude: -6.22, longitude: 106.85, fullAddress: 'Jl. Tebet 1', addressDetail: null, province: { name: 'DKI Jakarta' }, city: { name: 'Jakarta Selatan' },
    district: { name: 'Tebet' }, village: { name: 'Tebet Barat' },
  };
  const OUTLET = { id: 'o1', name: 'Pusat', postalCode: '40111', latitude: -6.91, longitude: 107.6, addressDetail: 'Jl. Outlet', province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Coblong' }, village: { name: 'Dago' } };
  const orders = (body: string) => {
    const { provider } = jne(body);
    const shipping = new ShippingService(new ShippingProviderFactory([paxel(), provider]));
    const prisma = {
      address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
      product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
      topping: { findMany: jest.fn().mockResolvedValue([]) },
      outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
      promo: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    return new OrdersService(prisma as never, shipping, { isCheckoutEnabled: () => false } as never, { issue: jest.fn() } as never,
      undefined, undefined, undefined, undefined, undefined, undefined, { enabled: false } as never);
  };
  const dto = (over: Record<string, unknown> = {}) => ({ address_id: 'addr-1', courier: 'jne', shipping_provider: 'jne', shipping_service: 'REG23', items: [{ product_id: 'p1', qty: 1 }], ...over });

  it('shipping options omit the zero-priced JNE service and keep Paxel', async () => {
    const options = await orders(oneRow('""')).getShippingOptions('u1', dto() as never);
    expect(options.map((o) => `${o.provider}:${o.service}:${o.shippingCost}`)).toEqual(['paxel:PAXEL_INSTANT:44000']);
  });

  it('a summary for the zero-priced JNE service is refused, never priced at Rp0', async () => {
    await expect(orders(oneRow('"0"')).getSummary('u1', dto() as never)).rejects.toThrow(new BadRequestException('Selected shipping service is unavailable'));
  });

  it('a valid JNE price is charged exactly', async () => {
    const summary = await orders(oneRow('"11000"')).getSummary('u1', dto() as never);
    expect([summary.shipping_cost, summary.grand_total]).toEqual([11000, 45000 + 11000]);
  });
});
