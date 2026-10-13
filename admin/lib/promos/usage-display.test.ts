import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPromoUsage } from './usage-display.ts';

// P1 #12 — a voucher created with maxUsageCount = 0 was shown in this list as
// "0 / ∞ Active", indistinguishable from an unlimited voucher, while the backend
// hid it from the homepage and rejected it at checkout.

test('REGRESSION: a zero-use limit is shown as 0, never as unlimited', () => {
  // The old truthiness check turned 0 into '∞'. This is the exact reported trap.
  assert.equal(formatPromoUsage(0, 0), '0 / 0');
  assert.notEqual(formatPromoUsage(0, 0), '0 / ∞', 'must not match an unlimited voucher');
});

test('null / undefined (no limit set) is the only "unlimited"', () => {
  assert.equal(formatPromoUsage(0, null), '0 / ∞');
  assert.equal(formatPromoUsage(3, undefined), '3 / ∞');
});

test('a positive limit renders used / limit', () => {
  assert.equal(formatPromoUsage(0, 5), '0 / 5');
  assert.equal(formatPromoUsage(5, 5), '5 / 5');
});

test('zero-use and unlimited vouchers are distinguishable (the #12 invariant)', () => {
  assert.notEqual(formatPromoUsage(0, 0), formatPromoUsage(0, null));
});
