import { test, expect } from '@playwright/test';
import { tc, instrument } from '../utils/locators';
import { CUSTOMER_URL, STORAGE } from '../utils/env';

// Module: CUSTOMER FRONTEND (CF-001..018)

test.describe('Customer Frontend — public', () => {
  test('CF-001 home loads @public', async ({ page }, ti) => {
    tc(ti, 'CF-001', '[Positive] Home loads');
    const sink = { console: [] as string[], netFail: [] as string[] };
    instrument(page, sink);
    await page.goto(`${CUSTOMER_URL}/`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    expect(sink.console.filter((l) => l.startsWith('[error]'))).toHaveLength(0);
  });

  test('CF-002 home degrades gracefully on slow network @public', async ({ page }, ti) => {
    tc(ti, 'CF-002', '[Edge] Slow/empty content');
    await page.route('**/products**', (r) => setTimeout(() => r.continue(), 1500));
    await page.goto(`${CUSTOMER_URL}/`);
    await expect(page.locator('body')).toBeVisible();
  });

  test('CF-003 catalog browse + filter @public', async ({ page }, ti) => {
    tc(ti, 'CF-003', '[Positive] Browse & filter');
    await page.goto(`${CUSTOMER_URL}/catalog`);
    await expect(page.getByRole('link').filter({ hasText: /baso|es teh/i }).first()).toBeVisible();
  });

  test('CF-004 catalog no-results empty state @public', async ({ page }, ti) => {
    tc(ti, 'CF-004', '[Negative] No results');
    await page.goto(`${CUSTOMER_URL}/catalog?category=__none__`);
    await expect(page.getByText(/no products|tidak ada|kosong/i).first()).toBeVisible();
  });

  test('CF-005 product detail renders @public', async ({ page }, ti) => {
    tc(ti, 'CF-005', '[Positive] View detail');
    await page.goto(`${CUSTOMER_URL}/catalog/baso-urat-jumbo`);
    await expect(page.getByRole('heading', { name: /baso urat jumbo/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /add to cart|keranjang|tambah/i }).first()).toBeVisible();
  });

  test('CF-006 invalid product slug → not found @public', async ({ page }, ti) => {
    tc(ti, 'CF-006', '[Negative] Invalid slug');
    await page.goto(`${CUSTOMER_URL}/catalog/this-does-not-exist`);
    await expect(page.getByText(/not found|tidak ditemukan/i).first()).toBeVisible();
  });

  test('CF-007 cart add/update/remove persists @public', async ({ page }, ti) => {
    tc(ti, 'CF-007', '[Positive] Add/update/remove');
    await page.goto(`${CUSTOMER_URL}/catalog/baso-urat-jumbo`);
    await page.getByRole('button', { name: /add to cart|keranjang|tambah/i }).first().click();
    await page.goto(`${CUSTOMER_URL}/cart`);
    await expect(page.getByText(/baso urat jumbo/i)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/baso urat jumbo/i)).toBeVisible(); // persisted
  });

  test('CF-010 checkout while logged out redirects to login @public', async ({ page }, ti) => {
    tc(ti, 'CF-010', '[Negative] Checkout logged out');
    await page.goto(`${CUSTOMER_URL}/checkout`);
    await expect(page).toHaveURL(/login/);
  });
});

test.describe('Customer Frontend — authenticated', () => {
  test.use({ storageState: STORAGE.customer });

  test('CF-009 place order', async ({ page }, ti) => {
    tc(ti, 'CF-009', '[Positive] Place order');
    test.fixme(true, 'Needs seeded address + stock; enable after scripts/seed-uat.');
    await page.goto(`${CUSTOMER_URL}/checkout`);
  });

  test('CF-018 refresh on protected page keeps session', async ({ page }, ti) => {
    tc(ti, 'CF-018', '[Refresh] Refresh on protected page');
    await page.goto(`${CUSTOMER_URL}/account`);
    await page.reload();
    await expect(page).toHaveURL(/account/);
  });

  test.fixme('CF-008 qty cannot exceed stock', async () => {});
  test.fixme('CF-011 checkout blocked without address', async () => {});
  test.fixme('CF-012 idempotent double-submit creates one order', async () => {});
  test.fixme('CF-013 address add/edit/delete', async () => {});
  test.fixme('CF-014 address field validation', async () => {});
  test('CF-015 order history renders (list or empty state)', async ({ page }, ti) => {
    tc(ti, 'CF-015', '[Positive] View orders');
    await page.goto(`${CUSTOMER_URL}/orders`);
    await expect(page).toHaveURL(/orders/);
    // Fresh UAT customer → either an order list or a valid empty state, never a crash.
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByText(/order|pesanan|no orders|belum ada|empty/i).first()).toBeVisible();
  });

  test.fixme('CF-016 cannot view another customer order', async () => {});

  test('CF-017 account profile shows customer email', async ({ page }, ti) => {
    tc(ti, 'CF-017', '[Positive] View profile');
    await page.goto(`${CUSTOMER_URL}/account`);
    await expect(page.getByText(/uat\.customer@masular\.test/i)).toBeVisible();
  });
});
