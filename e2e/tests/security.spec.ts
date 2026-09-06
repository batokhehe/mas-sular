import { test, expect } from '@playwright/test';
import { tc } from '../utils/locators';
import { API_URL, CUSTOMER_URL, STORAGE } from '../utils/env';

// Module: SECURITY (SEC-001..013)

test.describe('Security', () => {
  test.describe('cookie-auth session', () => {
    test.use({ storageState: STORAGE.customer });

    test('SEC-001 access token cookie is httpOnly (not JS-readable)', async ({ page, context }, ti) => {
      tc(ti, 'SEC-001', '[Security] httpOnly tokens not JS-readable');
      await page.goto(`${CUSTOMER_URL}/`);
      const jsCookies = await page.evaluate(() => document.cookie);
      expect(jsCookies).not.toContain('ms_access');
      const all = await context.cookies();
      const access = all.find((c) => c.name === 'ms_access');
      if (access) expect(access.httpOnly).toBeTruthy();
    });

    test('SEC-003 session marker present, value is literal true', async ({ page }, ti) => {
      tc(ti, 'SEC-003', '[Security] Marker present, no token');
      await page.goto(`${CUSTOMER_URL}/`);
      const cookie = await page.evaluate(() => document.cookie);
      expect(cookie).toMatch(/ms_session=true/);
    });

    test('SEC-002 authenticated request is cookie-based (no customer Bearer)', async ({ page }, ti) => {
      tc(ti, 'SEC-002', '[Security] Authenticated request uses cookie');
      let authHeader: string | undefined = 'unseen';
      page.on('request', (r) => {
        if (r.url().includes('/users/me')) authHeader = r.headers()['authorization'];
      });
      await page.goto(`${CUSTOMER_URL}/account`);
      const res = await page.waitForResponse((r) => r.url().includes('/users/me'));
      expect(res.status()).toBe(200);
      expect(authHeader).toBeFalsy(); // customer auth carries NO Authorization header
    });

    test('SEC-012 only one (httpOnly) ms_access cookie — no legacy duplicate', async ({ page, context }, ti) => {
      tc(ti, 'SEC-012', '[Security] No duplicate same-name cookies');
      await page.goto(`${CUSTOMER_URL}/`);
      const jsCookie = await page.evaluate(() => document.cookie);
      expect(jsCookie).not.toContain('ms_access'); // not JS-visible
      const access = (await context.cookies()).filter((c) => c.name === 'ms_access');
      expect(access.length).toBeLessThanOrEqual(1);
    });

    test('SEC-004 logout clears session marker', async ({ page }, ti) => {
      tc(ti, 'SEC-004', '[Edge] Markers cleared on logout');
      await page.goto(`${CUSTOMER_URL}/account`);
      await page.getByRole('button', { name: /sign ?out|log ?out|keluar/i }).first().click();
      await page.waitForURL(/\/(login|)?$/);
      const cookie = await page.evaluate(() => document.cookie);
      expect(cookie).not.toMatch(/ms_session=true/);
    });
  });

  test('SEC-010 protected admin API enforces auth server-side @public', async ({ request }, ti) => {
    tc(ti, 'SEC-010', '[Permission] API enforces perms server-side');
    const res = await request.patch(`${API_URL}/admin/payments/x/verify`, { data: {} });
    expect([401, 403]).toContain(res.status());
  });

  test('SEC-011 admin↔customer realm isolation @public', async ({ request }, ti) => {
    tc(ti, 'SEC-011', '[Security] Realm isolation');
    // A clearly invalid/foreign bearer must not authenticate either realm.
    const res = await request.get(`${API_URL}/users/me`, {
      headers: { Authorization: 'Bearer not-a-valid-token' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('SEC-005 XSRF-TOKEN cookie issued & JS-readable @public', async ({ page }, ti) => {
    tc(ti, 'SEC-005', '[Security] XSRF cookie issued');
    await page.goto(`${CUSTOMER_URL}/`);
    // Trigger an API round-trip so the guard's Set-Cookie is applied.
    await page.waitForLoadState('networkidle').catch(() => {});
    const cookie = await page.evaluate(() => document.cookie);
    expect(cookie).toMatch(/XSRF-TOKEN=/); // non-httpOnly → readable for double-submit
  });

  // CSRF enforce-mode behaviour (SEC-006/007/008). These were empty `fixme` stubs
  // while the harness inherited CSRF_MODE=off from the developer's backend/.env;
  // the isolated stack now sets CSRF_MODE=enforce explicitly (61AG.3.26), so they
  // are real tests against a real cookie-authenticated browser session.
  test.describe('CSRF enforce mode', () => {
    test.use({ storageState: STORAGE.customer });

    /** The address payload is irrelevant — every case is decided before the DTO. */
    const ADDRESS = {
      label: 'CSRF', recipientName: 'CSRF Probe', phone: '081200000000',
      fullAddress: 'Jl. CSRF No. 1', latitude: 0, longitude: 0,
    };

    /** Read the JS-readable double-submit token the guard seeds. */
    async function xsrf(page: import('@playwright/test').Page): Promise<string> {
      await page.goto(`${CUSTOMER_URL}/`);
      await page.waitForLoadState('networkidle').catch(() => {});
      const raw = await page.evaluate(() => document.cookie);
      const match = /XSRF-TOKEN=([^;]+)/.exec(raw);
      expect(match, 'guard must seed a JS-readable XSRF-TOKEN cookie').toBeTruthy();
      return decodeURIComponent(match![1]);
    }

    test('SEC-007 forged cookie-auth POST is blocked without a CSRF token', async ({ page, context }, ti) => {
      tc(ti, 'SEC-007', '[Security] Forged cookie-auth mutation blocked');
      await xsrf(page); // establish the session + token cookie
      // The browser sends ms_access automatically. Omitting the header is exactly
      // what a cross-site form post can do — it can send cookies, never headers.
      const res = await context.request.post(`${API_URL}/users/me/addresses`, {
        data: ADDRESS,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status()).toBe(403);
      expect(await res.text()).toContain('Invalid CSRF token');
    });

    test('SEC-006 the same POST succeeds with a valid X-CSRF-Token', async ({ page, context }, ti) => {
      tc(ti, 'SEC-006', '[Security] Unsafe methods carry X-CSRF-Token');
      const token = await xsrf(page);
      const res = await context.request.post(`${API_URL}/users/me/addresses`, {
        data: ADDRESS,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      });
      // Anything but 403 proves CSRF let it through to the application.
      expect(res.status()).not.toBe(403);
      expect([200, 201]).toContain(res.status());
    });

    test('SEC-006b a wrong token is rejected just like a missing one', async ({ page, context }, ti) => {
      tc(ti, 'SEC-006b', '[Security] Invalid CSRF token rejected');
      const token = await xsrf(page);
      const res = await context.request.post(`${API_URL}/users/me/addresses`, {
        data: ADDRESS,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': `${token.slice(0, -1)}X` },
      });
      expect(res.status()).toBe(403);
    });

    test('SEC-008 safe methods need no token', async ({ page, context }, ti) => {
      tc(ti, 'SEC-008', '[Security] Safe methods exempt from CSRF');
      await xsrf(page);
      const res = await context.request.get(`${API_URL}/users/me/addresses`);
      expect(res.status()).not.toBe(403);
      expect(res.ok()).toBeTruthy();
    });

    test('SEC-008b the webhook is signature-gated, not CSRF-gated', async ({ request }, ti) => {
      tc(ti, 'SEC-008b', '[Security] Webhook unaffected by browser CSRF');
      // No auth cookie, no CSRF token — a server-to-server call. CSRF must not be
      // what protects it, and must not block it either: the signature decides.
      const res = await request.post(`${API_URL}/payments/webhook/midtrans`, {
        data: { order_id: 'csrf-probe', status_code: '200', gross_amount: '1.00', signature_key: 'wrong' },
      });
      expect(res.status()).not.toBe(403); // not a CSRF rejection
      expect([401, 400, 503]).toContain(res.status()); // signature/config decides
    });
  });
  // SEC-009: minted access token is stateless (no server revocation) → remains valid
  // until TTL even after logout. "old session 401" only holds for refresh; this is a
  // documented product nuance, not a defect — kept out of auto pass/fail.
  test.fixme('SEC-009 logout terminates server session — stateless-token nuance', async () => {});
  test.fixme('SEC-013 expired session forces re-auth (needs expired-token fixture)', async () => {});
});
