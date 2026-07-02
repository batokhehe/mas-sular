import { test } from '@playwright/test';
import { tc } from '../utils/locators';
import { STORAGE } from '../utils/env';

// Module: SHIPPING FLOW (SHP-001..007)

test.describe('Shipping Flow — admin', () => {
  test.use({ storageState: STORAGE.admin });
  test('SHP-001 create shipment', async ({}, ti) => {
    tc(ti, 'SHP-001', '[Positive] Create shipment');
    test.fixme(true, 'Needs an order eligible for shipment in seed; mutating.');
  });
  test.fixme('SHP-002 missing required fields validated', async () => {});
  test.fixme('SHP-003 edit shipment', async () => {});
  test.fixme('SHP-004 advance shipment status', async () => {});
  test.fixme('SHP-005 add/edit tracking number', async () => {});
  test.fixme('SHP-006 delete shipment with confirm', async () => {});
  test.fixme('SHP-007 invalid tracking URL handled', async () => {});
});
