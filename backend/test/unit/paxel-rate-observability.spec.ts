import { Logger } from '@nestjs/common';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { ShippingQuote, ShippingRateRequest } from '../../src/modules/shipping/domain/shipping-provider.interface';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingService } from '../../src/modules/shipping/shipping.service';

/**
 * Paxel quote diagnostics and courier isolation (Phase 2).
 *
 * Production Paxel quotes failed with 404 and the only trace was a status code:
 * nothing said WHERE the request had gone. Every quote log line now carries the
 * endpoint as host + path - never the query string, the API key header or the
 * customer's street address - and a Paxel failure still never removes JNE.
 *
 * All HTTP is a stub: nothing here can reach Paxel.
 */

const API_KEY = 'pk_live_DO_NOT_LEAK_1234567890';
const SANDBOX = 'https://stage-commerce-api.paxel.co/v1';

function config(over: Partial<ShippingConfig['paxel']> = {}): ShippingConfig {
  return {
    allowMockRates: false,
    paxel: {
      enabled: true,
      baseUrl: SANDBOX,
      apiKey: API_KEY,
      apiSecret: 'sk_live_DO_NOT_LEAK_abcdefghij',
      timeoutMs: 500,
      maxRetry: 1,
      defaultDimension: '30x35x20',
      needInsurance: false,
      ...over,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  } as ShippingConfig;
}

const request: ShippingRateRequest = {
  originPostalCode: '40111',
  destinationPostalCode: '14270',
  weightGram: 1500,
  originAddress: 'Jl. Outlet No.1',
  originProvince: 'Jawa Barat',
  originCity: 'Kota Bandung',
  originDistrict: 'Coblong',
  originVillage: 'Dago',
  destinationAddress: 'Muara Karang Blok 7',
  destinationProvince: 'DKI Jakarta',
  destinationCity: 'Kota Jakarta Utara',
  destinationDistrict: 'Koja',
  destinationVillage: 'Pluit',
};

const res = (status: number, body = ''): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

function build(cfg: ShippingConfig, http: (url: string, init: ShippingHttpRequest) => Promise<ShippingHttpResponse>) {
  const provider = new PaxelProvider(cfg);
  const calls: Array<{ url: string; init: ShippingHttpRequest }> = [];
  (provider as unknown as { http: unknown }).http = async (url: string, init: ShippingHttpRequest) => {
    calls.push({ url, init });
    return http(url, init);
  };
  return { provider, calls };
}

/** Every structured object any Logger method was given during `fn`. */
async function captureLogs(fn: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      if (args[0] && typeof args[0] === 'object') lines.push(args[0] as Record<string, unknown>);
    }),
  );
  try {
    await fn().catch(() => undefined);
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
  return lines;
}

describe('quote URLs are built from the configured endpoint, prefix included', () => {
  it('city services go to <base>/rates/city and INSTANT to <base>/rates/instant', async () => {
    const { provider, calls } = build(config(), async () => res(404, 'Not Found'));
    await provider.getRates(request);
    expect(calls.map((c) => c.url).sort()).toEqual([
      `${SANDBOX}/rates/city`,
      `${SANDBOX}/rates/city`,
      `${SANDBOX}/rates/city`,
      `${SANDBOX}/rates/instant`,
    ]);
  });

  it('the API key travels only in its header', async () => {
    const { provider, calls } = build(config(), async () => res(404));
    await provider.getRates(request);
    for (const { init } of calls) {
      expect(init.headers['X-Paxel-API-Key']).toBe(API_KEY);
      expect(String(init.body)).not.toContain(API_KEY);
    }
  });
});

describe('a 404 is diagnosable from the logs alone', () => {
  it('logs provider, service, status, error class and host+path for every failed service', async () => {
    const { provider } = build(config(), async () => res(404, 'Not Found'));
    const logs = await captureLogs(() => provider.getRates(request));
    const failed = logs.filter((l) => l.provider === 'paxel' && l.status === 404);
    expect(failed).toHaveLength(4);
    for (const line of failed) {
      expect(line).toMatchObject({ errorClass: 'permanent_4xx', origin: 'Kota Bandung', destination: 'Kota Jakarta Utara' });
      expect(['stage-commerce-api.paxel.co/v1/rates/city', 'stage-commerce-api.paxel.co/v1/rates/instant']).toContain(
        line.endpoint,
      );
    }
    expect(new Set(failed.map((l) => l.service))).toEqual(
      new Set(['PAXEL_INSTANT', 'PAXEL_SAMEDAY', 'PAXEL_NEXTDAY', 'PAXEL_REGULAR']),
    );
  });

  it('a 404 is permanent: one attempt per service, no retry', async () => {
    const { provider, calls } = build(config({ maxRetry: 2 }), async () => res(404));
    await expect(provider.getRates(request)).resolves.toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it('a timeout/network error is transient: retried, then that service contributes nothing', async () => {
    const { provider, calls } = build(config({ maxRetry: 1 }), async () => {
      throw new Error('ETIMEDOUT');
    });
    await expect(provider.getRates(request)).resolves.toEqual([]);
    expect(calls).toHaveLength(8); // 4 services x (1 + 1 retry)
  });

  it('a 5xx is transient and retried', async () => {
    const { provider, calls } = build(config({ maxRetry: 1 }), async () => res(503));
    await provider.getRates(request);
    expect(calls).toHaveLength(8);
  });

  it('nothing logged carries the API key, the secret, the street address or a query string', async () => {
    const { provider } = build(config({ baseUrl: `${SANDBOX}` }), async () => res(404, `echo ${API_KEY}`));
    const logs = await captureLogs(() => provider.getRates(request));
    const all = JSON.stringify(logs);
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('sk_live_DO_NOT_LEAK');
    expect(all).not.toContain('Muara Karang');
    expect(all).not.toContain('Jl. Outlet');
    expect(all).not.toContain('?');
  });
});

describe('the environment guard also runs at request time', () => {
  it('a production config pointed at the sandbox host makes no HTTP call', async () => {
    const { provider, calls } = build(config({ environment: 'production' }), async () => res(200));
    await expect(provider.getRates(request)).rejects.toThrow(/known Paxel sandbox host/);
    expect(calls).toHaveLength(0);
  });

  it('an enabled config with no endpoint makes no HTTP call', async () => {
    const { provider, calls } = build(config({ baseUrl: '' }), async () => res(200));
    await expect(provider.getRates(request)).rejects.toThrow(/PAXEL_BASE_URL is required/);
    expect(calls).toHaveLength(0);
  });
});

describe('Paxel and JNE stay isolated', () => {
  const JNE_QUOTE: ShippingQuote = {
    provider: 'jne',
    service: 'REG',
    serviceName: 'JNE Reguler',
    estimatedDays: '1-2 Days',
    shippingCost: 9000,
  };
  const jne = { name: 'jne', getRates: jest.fn(async () => [JNE_QUOTE]) };

  it('Paxel answering 404 for every service leaves the JNE quotes intact', async () => {
    const { provider } = build(config(), async () => res(404));
    const shipping = new ShippingService({ getAll: () => [provider, jne] } as never);
    await expect(shipping.getQuotes(request)).resolves.toEqual([JNE_QUOTE]);
  });

  it('a Paxel environment misconfiguration (thrown) leaves the JNE quotes intact', async () => {
    const { provider } = build(config({ baseUrl: 'https://api.paxel.co' }), async () => res(200));
    const shipping = new ShippingService({ getAll: () => [provider, jne] } as never);
    await expect(shipping.getQuotes(request)).resolves.toEqual([JNE_QUOTE]);
  });

  it('JNE failing leaves working Paxel quotes intact', async () => {
    const ok = JSON.stringify({ data: { fixed_price: 47321, fixed_size: 'S' } });
    const { provider } = build(config(), async () => res(200, ok));
    const brokenJne = { name: 'jne', getRates: jest.fn(async () => { throw new Error('jne down'); }) };
    const shipping = new ShippingService({ getAll: () => [provider, brokenJne] } as never);
    const quotes = await shipping.getQuotes(request);
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.every((q) => q.provider === 'paxel')).toBe(true);
  });

  it('both failing still surfaces an error rather than "no couriers"', async () => {
    const { provider } = build(config({ baseUrl: '' }), async () => res(200));
    const brokenJne = { name: 'jne', getRates: jest.fn(async () => { throw new Error('jne down'); }) };
    const shipping = new ShippingService({ getAll: () => [provider, brokenJne] } as never);
    await expect(shipping.getQuotes(request)).rejects.toThrow();
  });
});
