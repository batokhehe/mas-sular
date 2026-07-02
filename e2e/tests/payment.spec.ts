import { test, expect } from '@playwright/test';
import { tc } from '../utils/locators';
import { API_URL, STORAGE } from '../utils/env';

// Module: PAYMENT FLOW (PAY-001..010)

test.describe('Payment Flow', () => {
  test('PAY-003 invalid/expired upload token rejected @public', async ({ request }, ti) => {
    tc(ti, 'PAY-003', '[Negative] Invalid/expired token');
    const res = await request.post(`${API_URL}/payments/upload/__invalid-token__/file`, {
      multipart: { file: { name: 'r.png', mimeType: 'image/png', buffer: Buffer.from('x') } },
    });
    expect([400, 401, 404]).toContain(res.status());
  });

  test.describe('admin queue', () => {
    test.use({ storageState: STORAGE.admin });
    test.fixme('PAY-005 verify advances order', async () => {});
    test.fixme('PAY-006 reject restores stock', async () => {});
    test.fixme('PAY-007 bulk verify aggregates one toast', async () => {});
    test.fixme('PAY-008 bulk verify partial-failure "n verified, m failed"', async () => {});
    test.fixme('PAY-009 bulk button disabled with no selection', async () => {});
    test.fixme('PAY-010 re-verify already-paid handled', async () => {});
  });

  test.describe('customer upload', () => {
    test.use({ storageState: STORAGE.customer });
    test.fixme('PAY-001 authenticated receipt upload', async () => {});
    test.fixme('PAY-002 token-gated anonymous upload', async () => {});
    test.fixme('PAY-004 non-image/oversized rejected', async () => {});
  });
});
