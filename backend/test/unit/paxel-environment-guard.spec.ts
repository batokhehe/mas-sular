/**
 * Paxel environment guard (Phase 2).
 *
 * Production quotes went to `https://api.paxel.co` - a code default nobody chose -
 * and every one of them answered 404. The guard makes the endpoint an explicit,
 * environment-checked choice:
 *
 *   - an enabled Paxel has NO default endpoint: PAXEL_BASE_URL must be set;
 *   - PAXEL_ENVIRONMENT=production may not use the known sandbox host or a test host;
 *   - PAXEL_ENVIRONMENT=sandbox (the default when unset) may ONLY use the known
 *     sandbox host or a reserved test host - so staging can never be pointed at a
 *     production endpoint by forgetting one variable.
 *
 * Credentials are never part of an error message.
 */
import {
  assertPaxelEnvironment,
  assertShippingConfigured,
  isPaxelSandboxUrl,
  loadShippingConfig,
  PAXEL_SANDBOX_HOSTS,
  PaxelProviderConfig,
} from '../../src/modules/shipping/shipping.config';

const SECRET_KEY = 'pk_live_DO_NOT_LEAK_1234567890';
const SECRET = 'sk_live_DO_NOT_LEAK_abcdefghij';

const ENABLED_ENV = {
  PAXEL_ENABLED: 'true',
  PAXEL_API_KEY: SECRET_KEY,
  PAXEL_API_SECRET: SECRET,
  PAXEL_ORIGIN_PHONE: '081234567890',
  PAXEL_ORIGIN_NOTE: 'Ambil di kasir',
};

/**
 * A stand-in for "some explicit, non-sandbox endpoint". Deliberately NOT Paxel's
 * real production URL (this repository does not know it) and not a reserved test
 * name either, so the guard treats it as production would treat the real one.
 */
const PROD_LIKE = 'https://production-api.courier-vendor.id/v1';

const load = (extra: Record<string, string | undefined>) =>
  loadShippingConfig({ ...ENABLED_ENV, ...extra } as unknown as NodeJS.ProcessEnv);

const boot = (extra: Record<string, string | undefined>) => () => assertShippingConfigured(load(extra));

describe('there is no default Paxel endpoint', () => {
  it('an unset PAXEL_BASE_URL leaves the endpoint empty instead of inventing api.paxel.co', () => {
    expect(load({}).paxel.baseUrl).toBe('');
  });

  it('an ENABLED Paxel without PAXEL_BASE_URL refuses to boot', () => {
    expect(boot({})).toThrow(/PAXEL_BASE_URL is required when PAXEL_ENABLED=true/);
    expect(boot({ PAXEL_BASE_URL: '   ' })).toThrow(/PAXEL_BASE_URL is required/);
  });

  it('a DISABLED Paxel needs no endpoint at all', () => {
    expect(() =>
      assertShippingConfigured(loadShippingConfig({ PAXEL_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv)),
    ).not.toThrow();
  });

  it('a malformed endpoint refuses to boot', () => {
    expect(boot({ PAXEL_BASE_URL: 'not a url' })).toThrow(/PAXEL_BASE_URL is not a valid absolute URL/);
  });

  it('trailing slashes are trimmed, the path prefix is kept verbatim', () => {
    expect(load({ PAXEL_BASE_URL: 'https://stage-commerce-api.paxel.co/v1///' }).paxel.baseUrl).toBe(
      'https://stage-commerce-api.paxel.co/v1',
    );
  });

  // Every request URL is `${baseUrl}${path}`: a query or fragment swallows the path and
  // credentials would travel on every call. Refused in BOTH environments.
  it.each([
    ['credentials', (base: string) => base.replace('https://', 'https://user:pass@')],
    ['a query string', (base: string) => `${base}?tenant=x`],
    ['a fragment', (base: string) => `${base}#rates`],
  ])('an endpoint with %s refuses to boot', (_what, withExtra) => {
    expect(boot({ PAXEL_BASE_URL: withExtra('https://stage-commerce-api.paxel.co/v1') })).toThrow(
      /scheme, host and path prefix only/,
    );
    expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: withExtra(PROD_LIKE) })).toThrow(
      /scheme, host and path prefix only/,
    );
  });
});

describe('PAXEL_ENABLED', () => {
  it.each(['true', '1'])('%p enables Paxel', (value) => {
    expect(load({ PAXEL_ENABLED: value }).paxel.enabled).toBe(true);
  });

  // Anything else is OFF - a typo can never switch a courier on.
  it.each(['TRUE', 'True', 'yes', 'on', 'enabled', 'flase', ' true', ''])('%p leaves Paxel disabled', (value) => {
    expect(load({ PAXEL_ENABLED: value }).paxel.enabled).toBe(false);
    // ...and a disabled courier boots whatever its endpoint says.
    expect(boot({ PAXEL_ENABLED: value, PAXEL_BASE_URL: 'not a url', PAXEL_ENVIRONMENT: 'nope' })).not.toThrow();
  });
});

describe('PAXEL_ENVIRONMENT', () => {
  it('defaults to sandbox when unset (the same convention as JNE_ENVIRONMENT)', () => {
    expect(load({ PAXEL_BASE_URL: 'https://stage-commerce-api.paxel.co/v1' }).paxel.environment).toBeUndefined();
    expect(boot({ PAXEL_BASE_URL: 'https://stage-commerce-api.paxel.co/v1' })).not.toThrow();
  });

  it('rejects an unknown value', () => {
    expect(boot({ PAXEL_ENVIRONMENT: 'prod', PAXEL_BASE_URL: 'https://commerce.paxel.example/v1' })).toThrow(
      /PAXEL_ENVIRONMENT must be "sandbox" or "production"/,
    );
  });

  // Exact and case-sensitive: "Production" is refused rather than guessed at.
  it.each(['Production', 'PRODUCTION', 'live', 'staging'])('rejects %p', (value) => {
    expect(boot({ PAXEL_ENVIRONMENT: value, PAXEL_BASE_URL: PROD_LIKE })).toThrow(
      /PAXEL_ENVIRONMENT must be "sandbox" or "production"/,
    );
  });

  it('surrounding whitespace is trimmed, as an env file may leave it', () => {
    expect(load({ PAXEL_ENVIRONMENT: ' production ', PAXEL_BASE_URL: PROD_LIKE }).paxel.environment).toBe('production');
    expect(boot({ PAXEL_ENVIRONMENT: ' production ', PAXEL_BASE_URL: PROD_LIKE })).not.toThrow();
  });

  describe('sandbox', () => {
    it.each([
      'https://stage-commerce-api.paxel.co/v1',
      'https://STAGE-COMMERCE-API.PAXEL.CO/v1',
      'https://paxel.test',
      'https://paxel.invalid',
      'http://localhost:4010/v1',
      'http://127.0.0.1:4010',
      'https://stage-commerce-api.paxel.co./v1',
    ])('accepts the known sandbox host or a reserved test host: %s', (url) => {
      expect(boot({ PAXEL_ENVIRONMENT: 'sandbox', PAXEL_BASE_URL: url })).not.toThrow();
    });

    it.each(['https://api.paxel.co', PROD_LIKE, 'https://paxel.co'])(
      'refuses anything else, so staging cannot reach a production endpoint: %s',
      (url) => {
        expect(boot({ PAXEL_ENVIRONMENT: 'sandbox', PAXEL_BASE_URL: url })).toThrow(/PAXEL_ENVIRONMENT=sandbox/);
        // ...and the same when PAXEL_ENVIRONMENT is simply forgotten.
        expect(boot({ PAXEL_BASE_URL: url })).toThrow(/PAXEL_ENVIRONMENT=sandbox/);
      },
    );
  });

  describe('production', () => {
    it('accepts an explicit non-sandbox endpoint', () => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: PROD_LIKE })).not.toThrow();
    });

    it('refuses the known sandbox host', () => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: 'https://stage-commerce-api.paxel.co/v1' })).toThrow(
        /production but PAXEL_BASE_URL points to the known Paxel sandbox/,
      );
    });

    // The same server under another spelling: an explicit port, upper case, or the DNS
    // root dot (`host.` resolves exactly like `host`).
    it.each([
      'https://stage-commerce-api.paxel.co:443/v1',
      'https://stage-commerce-api.paxel.co:8443/v1',
      'https://STAGE-COMMERCE-API.PAXEL.CO/v1',
      'https://stage-commerce-api.paxel.co./v1',
    ])('refuses the known sandbox host spelled %s', (url) => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: url })).toThrow(/known Paxel sandbox host/);
    });

    it.each(['https://paxel.test', 'http://localhost:4010', 'https://paxel.test.'])('refuses a test host: %s', (url) => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: url })).toThrow(/test host/);
    });

    it('refuses plain http', () => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: PROD_LIKE.replace('https:', 'http:') })).toThrow(
        /must use https/,
      );
    });

    it('still requires an explicit endpoint', () => {
      expect(boot({ PAXEL_ENVIRONMENT: 'production' })).toThrow(/PAXEL_BASE_URL is required/);
    });
  });

  it('a disabled courier is never checked', () => {
    const cfg = { enabled: false, environment: 'production', baseUrl: '' } as unknown as PaxelProviderConfig;
    expect(() => assertPaxelEnvironment(cfg)).not.toThrow();
  });
});

describe('the known sandbox host', () => {
  it('is exactly the staging endpoint host', () => {
    expect(PAXEL_SANDBOX_HOSTS).toEqual(['stage-commerce-api.paxel.co']);
    expect(isPaxelSandboxUrl('https://stage-commerce-api.paxel.co/v1')).toBe(true);
    expect(isPaxelSandboxUrl('https://stage-commerce-api.paxel.co.evil.example/v1')).toBe(false);
    expect(isPaxelSandboxUrl('https://api.paxel.co')).toBe(false);
  });
});

describe('no credential ever reaches an error message', () => {
  it.each([
    {},
    { PAXEL_BASE_URL: 'not a url' },
    { PAXEL_BASE_URL: 'https://api.paxel.co' },
    { PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: 'https://stage-commerce-api.paxel.co/v1' },
    { PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: 'http://commerce-api.paxel.example' },
    { PAXEL_ENVIRONMENT: 'nope', PAXEL_BASE_URL: 'https://paxel.test' },
    // The endpoint itself carrying a credential: the message must not echo the URL.
    { PAXEL_BASE_URL: `https://merchant:${SECRET}@stage-commerce-api.paxel.co/v1` },
    { PAXEL_ENVIRONMENT: 'production', PAXEL_BASE_URL: `https://commerce-api.paxel.example/v1?api_key=${SECRET_KEY}` },
    { PAXEL_BASE_URL: `https://api.paxel.co/v1#${SECRET}` },
    { PAXEL_BASE_URL: `http//${SECRET_KEY}` },
  ])('%p', (extra) => {
    let message = '';
    try {
      boot(extra)();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(SECRET_KEY);
    expect(message).not.toContain(SECRET);
  });
});
