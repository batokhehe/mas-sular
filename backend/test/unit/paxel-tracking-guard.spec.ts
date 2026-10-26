import { Logger } from '@nestjs/common';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { ShippingHttpRequest, ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingService } from '../../src/modules/shipping/shipping.service';

/**
 * PaxelProvider.track() enforces the same Paxel environment guard as quotes and
 * fulfillment (Phase 2.2). Before this, tracking was protected only at boot: a
 * request-time check makes every Paxel call - quote, create, cancel, track - refuse
 * an endpoint that does not match the declared tenant BEFORE the API key leaves.
 *
 * HTTP is a jest stub and every credential is a labelled dummy: nothing here can
 * reach Paxel.
 */

const API_KEY = 'pk_live_DO_NOT_LEAK_tracking_123456';
const API_SECRET = 'sk_live_DO_NOT_LEAK_tracking_abcdef';
const SANDBOX = 'https://stage-commerce-api.paxel.co/v1';
/** A stand-in for an explicit production endpoint - NOT Paxel's real URL. */
const PROD_LIKE = 'https://production-api.courier-vendor.id/v1';
const AWB = 'PXL1234567890';

function config(over: Partial<ShippingConfig['paxel']> = {}): ShippingConfig {
  return {
    allowMockRates: false,
    paxel: {
      enabled: true,
      baseUrl: SANDBOX,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      timeoutMs: 500,
      maxRetry: 0,
      defaultDimension: '30x35x20',
      needInsurance: false,
      ...over,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  } as ShippingConfig;
}

const ok = (status: string): ShippingHttpResponse => ({
  status: 200,
  text: async () => JSON.stringify({ data: { latest_status: status } }),
  headers: { get: () => null },
});

function build(cfg: ShippingConfig) {
  const provider = new PaxelProvider(cfg);
  const http = jest.fn(async (_url: string, _init: ShippingHttpRequest) => ok('DELIVERED'));
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('track() refuses an inconsistent environment before any HTTP request', () => {
  it('production pointed at the known sandbox host', async () => {
    const { provider, http } = build(config({ environment: 'production', baseUrl: SANDBOX }));
    await expect(provider.track(AWB)).rejects.toThrow(/production but PAXEL_BASE_URL points to the known Paxel sandbox host/);
    expect(http).not.toHaveBeenCalled();
  });

  it('sandbox (explicit) pointed at a non-sandbox host', async () => {
    const { provider, http } = build(config({ environment: 'sandbox', baseUrl: PROD_LIKE }));
    await expect(provider.track(AWB)).rejects.toThrow(/PAXEL_ENVIRONMENT=sandbox/);
    expect(http).not.toHaveBeenCalled();
  });

  it('sandbox by default (PAXEL_ENVIRONMENT unset) pointed at a non-sandbox host', async () => {
    const { provider, http } = build(config({ baseUrl: 'https://api.paxel.co' }));
    await expect(provider.track(AWB)).rejects.toThrow(/the default when unset/);
    expect(http).not.toHaveBeenCalled();
  });

  it('an enabled Paxel with no endpoint at all', async () => {
    const { provider, http } = build(config({ baseUrl: '' }));
    await expect(provider.track(AWB)).rejects.toThrow(/PAXEL_BASE_URL is required/);
    expect(http).not.toHaveBeenCalled();
  });

  it('production over plain http', async () => {
    const { provider, http } = build(config({ environment: 'production', baseUrl: PROD_LIKE.replace('https:', 'http:') }));
    await expect(provider.track(AWB)).rejects.toThrow(/must use https/);
    expect(http).not.toHaveBeenCalled();
  });

  it('an unknown PAXEL_ENVIRONMENT value', async () => {
    const { provider, http } = build(config({ environment: 'prod' as never }));
    await expect(provider.track(AWB)).rejects.toThrow(/PAXEL_ENVIRONMENT must be "sandbox" or "production"/);
    expect(http).not.toHaveBeenCalled();
  });

  it('no refusal message carries a credential or the tracking request', async () => {
    const cases = [
      config({ environment: 'production', baseUrl: SANDBOX }),
      config({ environment: 'sandbox', baseUrl: PROD_LIKE }),
      config({ baseUrl: '' }),
      config({ environment: 'production', baseUrl: PROD_LIKE.replace('https:', 'http:') }),
    ];
    for (const cfg of cases) {
      const message = await messageOf(build(cfg).provider.track(AWB));
      expect(message).not.toBe('');
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(API_SECRET);
    }
  });
});

describe('a consistent configuration tracks exactly as before', () => {
  it('sandbox: one GET to <base>/shipments/<awb> with the key in its header', async () => {
    const { provider, http } = build(config());
    await expect(provider.track(AWB)).resolves.toEqual({
      provider: 'paxel',
      trackingNumber: AWB,
      status: 'DELIVERED',
      history: [],
    });
    expect(http).toHaveBeenCalledTimes(1);
    const [url, init] = http.mock.calls[0];
    expect(url).toBe(`${SANDBOX}/shipments/${AWB}`);
    expect(init.method).toBe('GET');
    expect(init.headers['X-Paxel-API-Key']).toBe(API_KEY);
  });

  it('production with an explicit https endpoint', async () => {
    const { provider, http } = build(config({ environment: 'production', baseUrl: PROD_LIKE }));
    await expect(provider.track(AWB)).resolves.toMatchObject({ status: 'DELIVERED' });
    expect(http.mock.calls[0][0]).toBe(`${PROD_LIKE}/shipments/${AWB}`);
  });

  it('an unparseable courier answer still degrades to UNKNOWN, unchanged', async () => {
    const { provider, http } = build(config());
    http.mockResolvedValueOnce({ status: 200, text: async () => 'not json', headers: { get: () => null } });
    await expect(provider.track(AWB)).resolves.toMatchObject({ status: 'UNKNOWN' });
  });

  it('logs nothing that carries the API key', async () => {
    const lines: unknown[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args)),
    );
    try {
      await build(config()).provider.track(AWB);
      await build(config({ environment: 'production', baseUrl: SANDBOX })).provider.track(AWB).catch(() => undefined);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(JSON.stringify(lines)).not.toContain(API_KEY);
  });
});

describe('a disabled Paxel keeps its existing semantics', () => {
  it('answers UNKNOWN without any request, even with an inconsistent endpoint', async () => {
    // Disabled means "issues no requests", so there is nothing to guard: the
    // pre-existing answer is returned, never an environment error.
    const { provider, http } = build(config({ enabled: false, environment: 'production', baseUrl: SANDBOX }));
    await expect(provider.track(AWB)).resolves.toEqual({
      provider: 'paxel',
      trackingNumber: AWB,
      status: 'UNKNOWN',
      history: [],
    });
    expect(http).not.toHaveBeenCalled();
  });
});

describe('JNE tracking is unaffected by a Paxel misconfiguration', () => {
  it('ShippingService routes JNE tracking to JNE while Paxel would refuse', async () => {
    const { provider: paxel, http } = build(config({ environment: 'production', baseUrl: SANDBOX }));
    const jne = {
      name: 'jne',
      track: jest.fn(async (awb: string) => ({ provider: 'jne', trackingNumber: awb, status: 'IN_TRANSIT', history: [] })),
    };
    const registry = new Map<string, unknown>([
      ['paxel', paxel],
      ['jne', jne],
    ]);
    const shipping = new ShippingService({ get: (name: string) => registry.get(name), getAll: () => [...registry.values()] } as never);

    await expect(shipping.track('jne', 'CGK1234567890')).resolves.toMatchObject({ provider: 'jne', status: 'IN_TRANSIT' });
    await expect(shipping.track('paxel', AWB)).rejects.toThrow(/known Paxel sandbox host/);
    expect(jne.track).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });
});
