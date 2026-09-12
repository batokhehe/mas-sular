import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadCookieConfig } from '../../src/common/auth/auth-cookies.config';
import { setCustomerAuthCookies } from '../../src/common/auth/auth-cookies.util';
import { CsrfGuard } from '../../src/common/auth/csrf.guard';
import { envSchema, validateEnv } from '../../src/common/config/env.validation';
import { resolveRecipientPolicy } from '../../src/infrastructure/notifications/notification-delivery.gate';
import { resolveTrustProxyHops } from '../../src/common/http/trust-proxy';

/**
 * Production-readiness B4 — production.env.example is the production contract.
 *
 * It must (1) cover every validated variable, (2) be unbootable while any
 * placeholder is unfilled, (3) boot once filled, and (4) carry the values the
 * audit found wrong or missing: the admin /api/v1 URL, cookie auth, the parent
 * cookie domain, CSRF enforcement, one trusted proxy hop, a safe notification
 * default.
 */
const TEMPLATE = readFileSync(join(__dirname, '../../../production.env.example'), 'utf8');

/** KEY=VALUE lines that are set, and keys that only appear commented out (`# KEY=`). */
function parseTemplate(src: string) {
  const set: Record<string, string> = {};
  const commented = new Set<string>();
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim();
    const active = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (active) {
      set[active[1]] = active[2].replace(/\s+#.*$/, '').trim();
      continue;
    }
    const inactive = /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (inactive) commented.add(inactive[1]);
  }
  return { set, commented };
}

const { set: SET, commented: COMMENTED } = parseTemplate(TEMPLATE);
const mentioned = (key: string) => key in SET || COMMENTED.has(key);

/** The template with every placeholder filled, as an operator would. */
function filled(): Record<string, string> {
  const secret = () => randomBytes(32).toString('hex');
  const hosts: Record<string, string> = {
    '<ROOT_DOMAIN>': 'shop-root.example.invalid',
    '<SHOP_DOMAIN>': 'shop.shop-root.example.invalid',
    '<ADMIN_DOMAIN>': 'admin.shop-root.example.invalid',
    '<API_DOMAIN>': 'api.shop-root.example.invalid',
    '<GOOGLE_OAUTH_CLIENT_ID>': 'client-id.apps.googleusercontent.com',
    '<SUPPORT_EMAIL>': 'cs@shop-root.example.invalid',
  };
  const pgPassword = secret();
  const mqPassword = secret();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(SET)) {
    let v = value;
    for (const [ph, real] of Object.entries(hosts)) v = v.split(ph).join(real);
    if (key === 'POSTGRES_PASSWORD' || key === 'DATABASE_URL') v = v.replace('CHANGE_ME_strong_random_password', pgPassword);
    else if (key === 'RABBITMQ_PASSWORD' || key === 'RABBITMQ_URL') v = v.replace('CHANGE_ME_strong_random_password', mqPassword);
    else if (v === 'CHANGE_ME') v = secret();
    out[key] = v;
  }
  return out;
}

describe('B4: production.env.example covers the whole env contract', () => {
  it('lists every variable env.validation knows about (set, or commented with its condition)', () => {
    const shape = (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def.schema.shape;
    const missing = Object.keys(shape).filter((key) => key !== 'PORT' && !mentioned(key));
    expect(missing).toEqual([]);
  });

  it('also lists the production-relevant variables read outside the schema', () => {
    const extras = [
      'POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'RABBITMQ_USER', 'RABBITMQ_PASSWORD',
      'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_ADMIN_API_URL', 'NEXT_PUBLIC_GOOGLE_CLIENT_ID', 'NEXT_PUBLIC_SUPPORT_URL',
      'COOKIE_SECRET', 'ADMIN_URL', 'CHECKOUT_IDEMPOTENCY_REQUIRED',
      'NOTIFICATION_DELIVERY_ENABLED', 'NOTIFICATION_ALLOWED_RECIPIENTS',
      'QONTAK_INVOICE_TEMPLATE_ID', 'QONTAK_SHIPPED_TEMPLATE_ID', 'QONTAK_DELIVERED_TEMPLATE_ID',
      'QONTAK_MANUAL_TEMPLATE_ID', 'QONTAK_SHIPMENT_TEMPLATE_ID', 'QONTAK_ADMIN',
      'INVENTORY_RESERVATION_WORKER_ENABLED', 'SHIPMENT_TRACKING_ENABLED', 'SHIPMENT_RECONCILIATION_ENABLED',
      'RETENTION_ENABLED', 'RETENTION_DRY_RUN', 'MIDTRANS_RECONCILIATION_ENABLED',
      'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL', 'JWT_ADMIN_ACCESS_TTL', 'SWAGGER_ENABLED', 'FIREBASE_SERVICE_ACCOUNT_JSON',
    ];
    expect(extras.filter((key) => !mentioned(key))).toEqual([]);
  });

  it('keeps shape-validated keys ABSENT rather than empty (an empty value fails boot)', () => {
    for (const key of ['MIDTRANS_BASE_URL', 'QONTAK_BASE_URL', 'ADMIN_NOTIFICATION_EMAIL', 'JNE_ENVIRONMENT', 'PAXEL_ORIGIN_PHONE', 'PAXEL_ORIGIN_NOTE', 'PAXEL_DEFAULT_DIMENSION', 'PAXEL_PICKUP_CUTOFF_TIME', 'PAXEL_PICKUP_DEFAULT_TIME', 'PAXEL_PICKUP_TIMEZONE']) {
      expect(key in SET).toBe(false);
    }
  });

  it('contains no real credential: every secret is CHANGE_ME, every courier/Qontak value empty or commented', () => {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ADMIN_ACCESS_SECRET', 'COOKIE_SECRET']) expect(SET[key]).toBe('CHANGE_ME');
    for (const key of ['RESEND_API_KEY', 'QONTAK_API_TOKEN', 'MIDTRANS_SERVER_KEY', 'MIDTRANS_CLIENT_KEY']) expect(SET[key]).toBe('');
    for (const key of ['PAXEL_API_KEY', 'PAXEL_API_SECRET', 'JNE_API_KEY', 'GOOGLE_MAPS_API_KEY']) expect(key in SET).toBe(false);
  });
});

describe('B4: placeholders are unbootable; a filled template boots', () => {
  it('the template as shipped refuses to boot and names the unfilled keys', () => {
    expect(() => validateEnv(SET)).toThrow(/JWT_ACCESS_SECRET still holds a template placeholder/);
    expect(() => validateEnv(SET)).toThrow(/APP_URL/);
  });

  it('one forgotten placeholder is enough to refuse', () => {
    expect(() => validateEnv({ ...filled(), JWT_REFRESH_SECRET: 'CHANGE_ME_but_long_enough_to_pass_32_chars' })).toThrow(/JWT_REFRESH_SECRET still holds a template placeholder/);
    expect(() => validateEnv({ ...filled(), GOOGLE_CLIENT_ID: '<GOOGLE_OAUTH_CLIENT_ID>' })).toThrow(/GOOGLE_CLIENT_ID still holds/);
  });

  it('the filled template passes production validation', () => {
    expect(() => validateEnv(filled())).not.toThrow();
  });

  it('placeholders are not policed locally (dev files may legitimately use them)', () => {
    expect(() => validateEnv({ ...filled(), NODE_ENV: 'development', JWT_ACCESS_SECRET: 'CHANGE_ME_local_development_only_value' })).not.toThrow();
  });
});

describe('B4: the corrected production values', () => {
  const env = filled();

  it('storefront gets the bare API origin; admin gets the /api/v1 base', () => {
    expect(env.NEXT_PUBLIC_API_URL).toBe('https://api.shop-root.example.invalid');
    expect(env.NEXT_PUBLIC_API_URL.endsWith('/api/v1')).toBe(false);
    expect(env.NEXT_PUBLIC_ADMIN_API_URL).toBe('https://api.shop-root.example.invalid/api/v1');
  });

  it('customer cookie auth on, parent cookie domain, Secure + Lax, CSRF enforced', () => {
    const cookies = loadCookieConfig(env);
    expect(cookies.authCookieExtractorEnabled).toBe(true);
    expect(cookies.domain).toBe('.shop-root.example.invalid');
    expect(cookies.secure).toBe(true);
    expect(cookies.sameSite).toBe('lax');
    expect(cookies.csrfMode).toBe('enforce');
  });

  it('one trusted proxy hop; notifications default to the allowlist and stay off', () => {
    expect(resolveTrustProxyHops(env)).toBe(1);
    expect(resolveRecipientPolicy(env)).toBe('allowlist');
    expect(env.NOTIFICATION_SENDER_ENABLED).toBe('false');
    expect(env.NOTIFICATION_DELIVERY_ENABLED).toBe('false');
  });

  it('production workers are switched on explicitly (retention starts as a dry run)', () => {
    for (const key of ['OUTBOX_RELAY_ENABLED', 'CONSUMERS_ENABLED', 'PAYMENT_LIFECYCLE_ENABLED', 'INVENTORY_RESERVATION_WORKER_ENABLED', 'SHIPMENT_TRACKING_ENABLED', 'SHIPMENT_RECONCILIATION_ENABLED', 'RETENTION_ENABLED']) {
      expect([key, env[key]]).toEqual([key, 'true']);
    }
    expect(env.RETENTION_DRY_RUN).toBe('true');
  });
});

describe('B4: the cookie/CSRF topology works for shop.<root> -> api.<root>', () => {
  const saved = { ...process.env };
  beforeAll(() => Object.assign(process.env, filled()));
  afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  function httpContext(req: Record<string, unknown>) {
    const res = { cookie: jest.fn() };
    const request = { method: 'POST', path: '/api/v1/orders/checkout', headers: {}, cookies: {}, header: (n: string) => (req.headers as Record<string, string>)?.[n.toLowerCase()], ...req };
    return { res, ctx: { switchToHttp: () => ({ getRequest: () => request, getResponse: () => res }) } as never };
  }

  it('the API seeds XSRF-TOKEN on the PARENT domain, readable by the storefront (not httpOnly), Secure, Lax', () => {
    const { res, ctx } = httpContext({ method: 'GET', path: '/api/v1/catalog/products' });
    expect(new CsrfGuard().canActivate(ctx)).toBe(true);
    const [name, , options] = res.cookie.mock.calls[0];
    expect(name).toBe('XSRF-TOKEN');
    expect(options).toEqual(expect.objectContaining({ httpOnly: false, domain: '.shop-root.example.invalid', secure: true, sameSite: 'lax', path: '/' }));
  });

  it('customer auth cookies are httpOnly on the parent domain, Secure, Lax', () => {
    const res = { cookie: jest.fn() };
    setCustomerAuthCookies(res as never, { accessToken: 'a', refreshToken: 'r' });
    for (const [, , options] of res.cookie.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ httpOnly: true, domain: '.shop-root.example.invalid', secure: true, sameSite: 'lax' }));
    }
  });

  it('a cookie-authenticated write passes with the echoed token and is blocked without it', () => {
    const token = 'x'.repeat(43);
    const ok = httpContext({ cookies: { 'XSRF-TOKEN': token, ms_access: 'jwt' }, headers: { 'x-csrf-token': token } });
    expect(new CsrfGuard().canActivate(ok.ctx)).toBe(true);
    const blocked = httpContext({ cookies: { 'XSRF-TOKEN': token, ms_access: 'jwt' }, headers: {} });
    expect(() => new CsrfGuard().canActivate(blocked.ctx)).toThrow(/Invalid CSRF token/);
  });
});
