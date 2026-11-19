import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingDebounce } from '../debounce.ts';
import {
  applySearchChange,
  buildAdminOrdersQuery,
  normalizeOrderSearch,
  ORDER_SEARCH_DEBOUNCE_MS,
  ORDER_SEARCH_MAX_LENGTH,
  ORDER_STATUS_OPTIONS,
  type OrderListState,
} from './order-list-query.ts';

// Incident BMS-20261118-CKK0SJS2: search must reach the server, not filter the loaded page.

test('the search term is sent to GET /admin/orders, trimmed', () => {
  const q = new URLSearchParams(buildAdminOrdersQuery({ search: '  BMS-20261118-CKK0SJS2  ', page: 1, limit: 20 }));
  assert.equal(q.get('search'), 'BMS-20261118-CKK0SJS2');
  assert.equal(q.get('page'), '1');
  assert.equal(q.get('limit'), '20');
});

test('a lowercase pasted order number is sent unchanged (backend matches case-insensitively)', () => {
  const q = new URLSearchParams(buildAdminOrdersQuery({ search: 'bms-20261118-ckk0sjs2' }));
  assert.equal(q.get('search'), 'bms-20261118-ckk0sjs2');
});

test('a blank search sends no search parameter', () => {
  assert.equal(buildAdminOrdersQuery({ search: '   ' }), '');
  assert.equal(buildAdminOrdersQuery({}), '');
});

test('search combines with status and paymentStatus', () => {
  const q = new URLSearchParams(buildAdminOrdersQuery({ search: 'ckk0', status: 'PROCESSING', paymentStatus: 'PAID' }));
  assert.equal(q.get('search'), 'ckk0');
  assert.equal(q.get('status'), 'PROCESSING');
  assert.equal(q.get('paymentStatus'), 'PAID');
});

test(`the search term is capped at ${ORDER_SEARCH_MAX_LENGTH} characters (backend limit)`, () => {
  assert.equal(normalizeOrderSearch('x'.repeat(250))?.length, ORDER_SEARCH_MAX_LENGTH);
});

test('a new search resets to page 1; the same search keeps the page', () => {
  const onPage7: OrderListState = { search: '', page: 7 };
  assert.deepEqual(applySearchChange(onPage7, 'CKK0SJS2'), { search: 'CKK0SJS2', page: 1 });
  const searching: OrderListState = { search: 'CKK0SJS2', page: 3 };
  assert.equal(applySearchChange(searching, '  CKK0SJS2 '), searching);
  assert.deepEqual(applySearchChange(searching, ''), { search: '', page: 1 });
});

test('typing is debounced: one search commit ~300 ms after the last keystroke, then page 1', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let state: OrderListState = { search: '', page: 7 };
  let commits = 0;
  const commit = trailingDebounce((raw: string) => {
    commits += 1;
    state = applySearchChange(state, raw);
  }, ORDER_SEARCH_DEBOUNCE_MS);

  for (const partial of ['C', 'CK', 'CKK', 'CKK0']) {
    commit(partial);
    t.mock.timers.tick(100);
  }
  assert.equal(commits, 0);
  assert.deepEqual(state, { search: '', page: 7 });

  t.mock.timers.tick(ORDER_SEARCH_DEBOUNCE_MS);
  assert.equal(commits, 1);
  assert.deepEqual(state, { search: 'CKK0', page: 1 });
});

test('status options cover every backend OrderStatus, including SHIPPED and DELIVERED', () => {
  const backend = ['PENDING', 'PROCESSING', 'DELIVERING', 'COMPLETED', 'CANCELLED', 'PACKING', 'SHIPPED', 'DELIVERED'];
  for (const s of backend) assert.ok((ORDER_STATUS_OPTIONS as readonly string[]).includes(s), s);
  assert.equal(ORDER_STATUS_OPTIONS[0], 'ALL');
  assert.equal(ORDER_STATUS_OPTIONS.length, backend.length + 1);
});
