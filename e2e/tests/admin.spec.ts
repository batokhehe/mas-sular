import { test, expect } from '@playwright/test';
import { tc } from '../utils/locators';
import { ADMIN_URL, API_URL, STORAGE } from '../utils/env';

// Module: ADMIN PANEL (ADM-001..021)

test.describe('Admin Panel — security gates (public/API)', () => {
  test('ADM-018 admin API rejects unauthenticated @public', async ({ request }, ti) => {
    tc(ti, 'ADM-018', '[Permission] Non-privileged/anon blocked');
    for (const path of ['/admin/dashboard', '/admin/orders', '/admin/users', '/admin/roles']) {
      const res = await request.get(`${API_URL}${path}`);
      expect([401, 403], `${path}`).toContain(res.status());
    }
  });
});

test.describe('Admin Panel — authenticated', () => {
  test.use({ storageState: STORAGE.admin });

  test('ADM-001 dashboard metrics render', async ({ page }, ti) => {
    tc(ti, 'ADM-001', '[Positive] Metrics load');
    await page.goto(`${ADMIN_URL}/dashboard`);
    await expect(page.getByText(/orders|revenue|payments|stock/i).first()).toBeVisible();
  });

  test('ADM-002 create category shows success', async ({ page }, ti) => {
    tc(ti, 'ADM-002', '[Positive] Create category');
    test.fixme(true, 'Mutating test — run against disposable seed DB only.');
    await page.goto(`${ADMIN_URL}/categories/new`);
  });

  test('ADM-003 delete shows confirm dialog', async ({ page }, ti) => {
    tc(ti, 'ADM-003', '[Positive] Delete with confirm');
    test.fixme(true, 'Needs a deletable seeded category; SweetAlert confirm assertion.');
    await page.goto(`${ADMIN_URL}/categories`);
  });

  test.fixme('ADM-004 cancel delete makes no API call', async () => {});
  test.fixme('ADM-005 create product with image upload', async () => {});
  test.fixme('ADM-006 product form requires image', async () => {});
  test.fixme('ADM-007 update + delete product', async () => {});
  test.fixme('ADM-008 promo CRUD', async () => {});
  test.fixme('ADM-009 banner CRUD', async () => {});
  test.fixme('ADM-010 order detail view', async () => {});
  test.fixme('ADM-011 order status change with confirm', async () => {});
  test.fixme('ADM-012 verify single payment', async () => {});
  test.fixme('ADM-013 reject single payment', async () => {});
  test.fixme('ADM-014 double-click verify disabled while pending', async () => {});
  test.fixme('ADM-015 create shipment', async () => {});
  test.fixme('ADM-016 activate/deactivate user with confirm', async () => {});
  test.fixme('ADM-017 create/edit role', async () => {});
  test.fixme('ADM-019 mutation error feedback modal', async () => {});

  test('ADM-020 refresh mid-session retains admin', async ({ page }, ti) => {
    tc(ti, 'ADM-020', '[Refresh] Refresh mid-session');
    await page.goto(`${ADMIN_URL}/dashboard`);
    await page.reload();
    await expect(page).toHaveURL(/dashboard/);
  });

  test.fixme('ADM-021 SUPER_ADMIN full access', async () => {});
});
