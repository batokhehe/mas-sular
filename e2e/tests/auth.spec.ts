import { test, expect } from '@playwright/test';
import { tc } from '../utils/locators';
import { ADMIN_URL, API_URL, CUSTOMER_URL, STORAGE } from '../utils/env';

// Module: AUTHENTICATION (AUTH-001..015)

test.describe('Authentication', () => {
  test('AUTH-001 customer login page renders Google entry @public', async ({ page }, ti) => {
    tc(ti, 'AUTH-001', '[Positive] Google OAuth entry available');
    await page.goto(`${CUSTOMER_URL}/login`);
    // Login uses Google Identity Services (GSI) — the button renders inside a Google
    // iframe, so assert the page + that GSI is wired (script/iframe), not a <button>.
    await expect(page.getByText(/sign in|masuk|order|track/i).first()).toBeVisible();
    await expect(
      page.locator('script[src*="gsi/client"], iframe[src*="accounts.google.com"]').first(),
    ).toBeAttached();
    // NOTE: completing real Google OAuth is not automatable; authenticated state is
    // injected via the cookie-mint setup (tests/auth.setup.ts).
  });

  test.fixme('AUTH-002 cancel Google consent returns to /login', async () => {
    // Blocked: requires the real Google consent screen (external, non-automatable).
  });

  test.fixme('AUTH-003 disabled account rejected', async () => {
    // Needs a seeded isActive=false customer + cookie-mint variant. Run after seed-uat.
  });

  test('AUTH-004 customer logout clears session', async ({ browser }, ti) => {
    tc(ti, 'AUTH-004', '[Positive] Logout clears session');
    const ctx = await browser.newContext({ storageState: STORAGE.customer });
    const page = await ctx.newPage();
    await page.goto(`${CUSTOMER_URL}/account`);
    await page.getByRole('button', { name: /sign ?out|log ?out|keluar/i }).first().click();
    await expect(page).toHaveURL(/\/(login|)?$/);
    await ctx.close();
  });

  test('AUTH-005 admin login reaches dashboard', async ({ browser }, ti) => {
    tc(ti, 'AUTH-005', '[Positive] Valid admin credentials');
    const ctx = await browser.newContext({ storageState: STORAGE.admin });
    const page = await ctx.newPage();
    await page.goto(`${ADMIN_URL}/dashboard`);
    await expect(page).toHaveURL(/dashboard/);
    await ctx.close();
  });

  test('AUTH-006 admin wrong password rejected @public', async ({ request }, ti) => {
    tc(ti, 'AUTH-006', '[Negative] Wrong password');
    const res = await request.post(`${API_URL}/admin/auth/login`, {
      data: { email: 'nobody@masular.test', password: 'wrong-password' },
    });
    expect(res.status()).toBe(401);
  });

  test('AUTH-007 admin login validates empty fields @public', async ({ request }, ti) => {
    tc(ti, 'AUTH-007', '[Validation] Empty fields');
    const res = await request.post(`${API_URL}/admin/auth/login`, { data: {} });
    expect([400, 401]).toContain(res.status());
  });

  test('AUTH-008 admin logout blocks admin routes', async ({ browser }, ti) => {
    tc(ti, 'AUTH-008', '[Positive] Admin logout');
    const ctx = await browser.newContext({ storageState: STORAGE.admin });
    const page = await ctx.newPage();
    await page.goto(`${ADMIN_URL}/dashboard`);
    await page.getByRole('button', { name: /log ?out|keluar/i }).first().click();
    await expect(page).toHaveURL(/login/);
    await ctx.close();
  });

  test('AUTH-009 session persists on refresh', async ({ browser }, ti) => {
    tc(ti, 'AUTH-009', '[Refresh] Reload keeps session');
    const ctx = await browser.newContext({ storageState: STORAGE.customer });
    const page = await ctx.newPage();
    await page.goto(`${CUSTOMER_URL}/account`);
    await page.reload();
    await expect(page).toHaveURL(/account/);
    await ctx.close();
  });

  test('AUTH-010 session shared in new tab', async ({ browser }, ti) => {
    tc(ti, 'AUTH-010', '[Edge] New tab shares session');
    const ctx = await browser.newContext({ storageState: STORAGE.customer });
    const p1 = await ctx.newPage();
    await p1.goto(`${CUSTOMER_URL}/account`);
    const p2 = await ctx.newPage();
    await p2.goto(`${CUSTOMER_URL}/account`);
    await expect(p2).toHaveURL(/account/);
    await ctx.close();
  });

  test.fixme('AUTH-011 access expiry triggers silent refresh', async () => {
    // Needs a short-TTL minted access + valid refresh cookie; mint variant pending.
  });
  test.fixme('AUTH-012 refresh expiry logs out gracefully', async () => {
    // Needs an expired/revoked refresh cookie fixture.
  });

  test('AUTH-013 customer cannot reach admin @public', async ({ request }, ti) => {
    tc(ti, 'AUTH-013', '[Permission] Customer cannot reach admin');
    const res = await request.get(`${API_URL}/admin/dashboard`);
    expect([401, 403]).toContain(res.status());
  });

  test('AUTH-014 admin token rejected on customer endpoint @public', async ({ request }, ti) => {
    tc(ti, 'AUTH-014', '[Permission] Admin realm isolation');
    const login = await request.post(`${API_URL}/admin/auth/login`, {
      data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
    });
    test.skip(!login.ok(), 'admin creds not available');
    const { accessToken } = await login.json();
    const res = await request.get(`${API_URL}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect([401, 403]).toContain(res.status()); // admin secret ≠ customer secret
  });
  test.fixme('AUTH-015 re-login after logout yields fresh session', async () => {
    // Depends on automatable login; customer side blocked by OAuth.
  });
});
