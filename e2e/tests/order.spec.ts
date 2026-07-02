import { test } from '@playwright/test';
import { tc } from '../utils/locators';
import { STORAGE } from '../utils/env';

// Module: ORDER FLOW (ORD-001..008)

test.describe('Order Flow — customer', () => {
  test.use({ storageState: STORAGE.customer });
  test('ORD-001 create order from cart', async ({}, ti) => {
    tc(ti, 'ORD-001', '[Positive] Order from cart');
    test.fixme(true, 'Needs seeded address + in-stock product; mutating.');
  });
  test.fixme('ORD-002 out-of-stock blocked at checkout', async () => {});
  test.fixme('ORD-007 customer sees updated status', async () => {});
  test.fixme('ORD-008 cross-customer order isolation', async () => {});
});

test.describe('Order Flow — admin', () => {
  test.use({ storageState: STORAGE.admin });
  test.fixme('ORD-003 PROCESSING→DELIVERING→COMPLETED progression', async () => {});
  test.fixme('ORD-004 invalid transition rejected', async () => {});
  test.fixme('ORD-005 cancel order', async () => {});
  test.fixme('ORD-006 cannot cancel completed order', async () => {});
});
