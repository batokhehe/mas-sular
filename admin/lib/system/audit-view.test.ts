import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionBadge, entityHref, entrySummary, diffRows, serializeFilters, parseFilters, csvFilename,
} from './audit-view.ts';

test('diff viewer: rows render backend diff verbatim (before → after, nulls as —)', () => {
  const rows = diffRows([
    { field: 'price', before: 25000, after: 28000 },
    { field: 'stock', before: 10, after: 5 },
    { field: 'note', before: null, after: 'hi' },
  ]);
  assert.deepEqual(rows[0], { field: 'price', before: '25000', after: '28000' });
  assert.deepEqual(rows[2], { field: 'note', before: '—', after: 'hi' });
  assert.deepEqual(diffRows(null), []);
});

test('badges: every named action mapped; unknown falls back to gray', () => {
  for (const a of ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'VERIFY_PAYMENT', 'CANCEL_ORDER', 'TRANSFER_STOCK', 'ASSIGN_ROLE', 'SEND_MANUAL_NOTIFICATION']) {
    assert.ok(actionBadge(a));
    assert.doesNotMatch(actionBadge(a), /^bg-gray-100 text-gray-600$/, `named action ${a} should have a specific tone`);
  }
  assert.match(actionBadge('SOMETHING_ELSE'), /gray/);
});

test('entity links: known entities route to their admin pages', () => {
  assert.equal(entityHref('Order', 'o1'), '/orders/o1');
  assert.equal(entityHref('Product', 'p1'), '/products/p1');
  assert.equal(entityHref('Role', 'r1'), '/roles/r1');
  assert.equal(entityHref('Voucher', 'v1'), '/promos/v1');
  assert.equal(entityHref('Unknown', 'x'), null);
  assert.equal(entityHref('Order', null), null);
});

test('table summary: diff count, else entity name, else humanized action', () => {
  assert.equal(entrySummary({ diff: [{ field: 'a', before: 1, after: 2 }], action: 'UPDATE', entityName: null }), '1 field changed');
  assert.equal(entrySummary({ diff: [], action: 'VERIFY_PAYMENT', entityName: 'BMS-1' }), 'BMS-1');
  assert.equal(entrySummary({ diff: null, action: 'CANCEL_ORDER', entityName: null }), 'cancel order');
});

test('filters: remembered via serialize/parse round-trip; corrupt data degrades to {}', () => {
  const filters = { module: 'payments', action: 'VERIFY_PAYMENT', success: 'true' as const, page: 2 };
  assert.deepEqual(parseFilters(serializeFilters(filters)), filters);
  assert.deepEqual(parseFilters(null), {});
  assert.deepEqual(parseFilters('{corrupt'), {});
});

test('csv: dated filename', () => {
  assert.equal(csvFilename(new Date('2026-07-08T10:00:00Z')), 'audit-trail-2026-07-08.csv');
});
