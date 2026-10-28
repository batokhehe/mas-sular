/**
 * Regression: nothing in the unit suite can book, cancel or quote with a real Paxel.
 *
 * Three independent locks, each pinned here so a later change to one of them fails
 * loudly instead of quietly turning a test run into real courier traffic:
 *
 *   1. Defaults - an empty environment (and the environment this suite runs in)
 *      leaves Paxel, automatic pickup and shipment reconciliation OFF.
 *   2. The provider boundary - a disabled or mis-configured Paxel refuses a booking
 *      or cancellation before any HTTP request, with no credential in the error.
 *   3. The transport - the unit-test fetch tripwire (test/setup/no-external-network.ts)
 *      refuses every real host, so even a provider whose HTTP double was forgotten
 *      cannot leave the machine.
 */
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';
import { loadShipmentReconciliationConfig } from '../../src/modules/shipment/shipment-reconciliation.config';
import { PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { defaultShippingHttpClient } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { PaxelProvider } from '../../src/modules/shipping/infrastructure/providers/paxel.provider';
import { loadShippingConfig, PaxelProviderConfig, ShippingConfig } from '../../src/modules/shipping/shipping.config';

const API_KEY = 'pk_live_DO_NOT_LEAK_1234567890';
const API_SECRET = 'sk_live_DO_NOT_LEAK_abcdefghij';
const SANDBOX = 'https://stage-commerce-api.paxel.co/v1';
const PROD_LIKE = 'https://production-api.courier-vendor.id/v1';

function config(paxel: Partial<PaxelProviderConfig>): ShippingConfig {
  return {
    allowMockRates: false,
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 500, maxRetry: 1 },
    paxel: {
      enabled: true,
      baseUrl: SANDBOX,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      originPhone: '081212121212',
      originNote: 'gerbang samping',
      timeoutMs: 500,
      maxRetry: 0,
      defaultDimension: '30x35x20',
      needInsurance: false,
      ...paxel,
    },
    jne: { enabled: false, baseUrl: 'https://jne.test', timeoutMs: 500, maxRetry: 0 },
  };
}

function withHttpDouble<T extends object>(provider: T) {
  const http = jest.fn();
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http };
}

/** The guard runs before the payload is built, so the input is never read. */
const INPUT = {} as CreateShipmentInput;

describe('defaults keep every Paxel side effect off', () => {
  it('an empty environment disables Paxel, automatic pickup and reconciliation', () => {
    const shipping = loadShippingConfig({} as NodeJS.ProcessEnv);
    expect(shipping.paxel.enabled).toBe(false);
    expect(shipping.paxel.autoPickup?.enabled).toBe(false);
    expect(shipping.paxel.baseUrl).toBe('');
    expect(loadShipmentReconciliationConfig({} as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it('the environment this suite runs in does not switch any of them on', () => {
    // Fails when a shell or CI variable would make the unit run a live courier client.
    const shipping = loadShippingConfig(process.env);
    expect({
      paxel: shipping.paxel.enabled,
      autoPickup: shipping.paxel.autoPickup?.enabled,
      reconciliation: loadShipmentReconciliationConfig(process.env).enabled,
    }).toEqual({ paxel: false, autoPickup: false, reconciliation: false });
  });
});

describe('a booking or cancellation is refused before any HTTP request', () => {
  it.each([
    ['Paxel is disabled', { enabled: false }, /Paxel fulfillment is disabled/],
    ['no endpoint is configured', { baseUrl: '' }, /PAXEL_BASE_URL is required/],
    ['sandbox (unset) points at a non-sandbox host', { baseUrl: PROD_LIKE }, /PAXEL_ENVIRONMENT=sandbox/],
    ['production points at the sandbox host', { environment: 'production', baseUrl: SANDBOX }, /known Paxel sandbox host/],
    ['production uses plain http', { environment: 'production', baseUrl: PROD_LIKE.replace('https:', 'http:') }, /must use https/],
    ['production has no API path prefix', { environment: 'production', baseUrl: 'https://production-api.courier-vendor.id' }, /must include the API path prefix/],
    ['the sandbox host has no API path prefix', { baseUrl: 'https://stage-commerce-api.paxel.co' }, /must include the API path prefix/],
    ['the endpoint embeds a credential', { baseUrl: `https://m:${API_SECRET}@stage-commerce-api.paxel.co/v1` }, /path prefix only/],
    ['the environment is unknown', { environment: 'prod' as never, baseUrl: PROD_LIKE }, /must be "sandbox" or "production"/],
  ] as const)('when %s', async (_why, paxel, expected) => {
    const { provider, http } = withHttpDouble(new PaxelShipmentProvider(config(paxel)));

    for (const call of [() => provider.createShipment(INPUT), () => provider.cancelShipment('AWB-1')]) {
      const error = await call().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(PermanentError);
      const message = (error as Error).message;
      expect(message).toMatch(expected);
      expect(message).not.toContain(API_KEY);
      expect(message).not.toContain(API_SECRET);
    }
    expect(http).not.toHaveBeenCalled();
  });

  it('a disabled Paxel in production quotes nothing and calls nothing', async () => {
    const { provider, http } = withHttpDouble(new PaxelProvider(config({ enabled: false })));
    await expect(
      provider.getRates({ paxelBoxSize: 'SMALL' } as unknown as Parameters<PaxelProvider['getRates']>[0]),
    ).resolves.toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });
});

describe('the unit-test transport cannot reach a real host', () => {
  it.each([SANDBOX, PROD_LIKE, 'https://api.paxel.co', 'https://stage-commerce-api.paxel.co./v1'])(
    'fetch to %s is refused before a socket is opened',
    async (base) => {
      await expect(
        defaultShippingHttpClient(`${base}/shipments`, { method: 'POST', headers: {}, body: '{}', timeoutMs: 500 }),
      ).rejects.toThrow(/Unit tests must not reach external hosts/);
    },
  );

  it('a provider whose HTTP double was forgotten still cannot book', async () => {
    // Enabled, consistent sandbox configuration and NO injected transport: the only
    // thing between this call and Paxel's sandbox is the tripwire.
    const provider = new PaxelShipmentProvider(config({}));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      await expect(provider.cancelShipment('AWB-1')).rejects.toBeDefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await expect(fetchSpy.mock.results[0].value).rejects.toThrow(/blocked fetch to stage-commerce-api\.paxel\.co/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('loopback is still allowed through to the real fetch', async () => {
    // Port 9 (discard) has no listener here, so the connection is refused locally -
    // but by the operating system, not by the tripwire.
    await expect(
      defaultShippingHttpClient('http://127.0.0.1:9/v1/shipments', { method: 'GET', headers: {}, timeoutMs: 500 }),
    ).rejects.not.toThrow(/Unit tests must not reach external hosts/);
  });
});
