import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distinctServices, serviceLabel } from './prepare-shipment.ts';

/**
 * PAXELBOX-18 withdrew the operator service selector, so there is no default to
 * derive and no override to track any more. What remains is display: show each
 * order the service its customer actually paid for, and never translate a code
 * into a Paxel service they did not buy.
 */

const OPTIONS = [
  { value: 'PAXEL_INSTANT', label: 'Instant' },
  { value: 'PAXEL_SAMEDAY', label: 'Same Day' },
  { value: 'PAXEL_NEXTDAY', label: 'Next Day' },
  { value: 'PAXEL_REGULAR', label: 'Regular' },
];

const order = (id: string, shippingService?: string | null) => ({ id, shippingService });

test('a known Paxel code shows its catalogue label', () => {
  assert.equal(serviceLabel('PAXEL_INSTANT', OPTIONS), 'Instant');
  assert.equal(serviceLabel('PAXEL_SAMEDAY', OPTIONS), 'Same Day');
  assert.equal(serviceLabel('PAXEL_NEXTDAY', OPTIONS), 'Next Day');
  assert.equal(serviceLabel('PAXEL_REGULAR', OPTIONS), 'Regular');
});

test('a JNE code is shown verbatim, never mapped to a Paxel service', () => {
  const label = serviceLabel('REG', OPTIONS);
  assert.equal(label, 'REG');
  assert.notEqual(label, 'Regular');
});

test('an unknown code is shown verbatim rather than guessed', () => {
  assert.equal(serviceLabel('SOMETHING_NEW', OPTIONS), 'SOMETHING_NEW');
});

test('a missing service reads as "Not set", not as a default service', () => {
  assert.equal(serviceLabel(null, OPTIONS), 'Not set');
  assert.equal(serviceLabel(undefined, OPTIONS), 'Not set');
  assert.equal(serviceLabel('', OPTIONS), 'Not set');
});

test('a single-service selection reports exactly that one service', () => {
  assert.deepEqual(distinctServices([order('a', 'PAXEL_INSTANT')]), ['PAXEL_INSTANT']);
});

test('a batch agreeing on one service collapses to one entry', () => {
  const orders = [order('a', 'PAXEL_INSTANT'), order('b', 'PAXEL_INSTANT')];
  assert.deepEqual(distinctServices(orders), ['PAXEL_INSTANT']);
});

test('a mixed batch reports every service, in first-seen order', () => {
  const orders = [order('a', 'PAXEL_INSTANT'), order('b', 'REG'), order('c', 'PAXEL_INSTANT')];
  assert.deepEqual(distinctServices(orders), ['PAXEL_INSTANT', 'REG']);
});

test('empty selection has no services', () => {
  assert.deepEqual(distinctServices([]), []);
});

test('the module exposes no way to choose or send a service', async () => {
  // The override is withdrawn: nothing here may hand the panel a value to
  // submit, or a future change could quietly reinstate the mismatch.
  const module = await import('./prepare-shipment.ts');
  assert.deepEqual(Object.keys(module).sort(), ['distinctServices', 'serviceLabel']);
});
