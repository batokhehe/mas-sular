import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERF_RANGES, formatMs, sortEndpoints, filterEndpoints, latencyTone } from './performance-view.ts';

const ep = (over: Record<string, unknown> = {}) => ({
  endpoint: 'GET /api/v1/products', method: 'GET', path: '/api/v1/products',
  count: 10, avgMs: 100, maxMs: 500, p95: 300, p99: 450, latest: [],
  ...over,
});

test('ranges: all four time filters defined', () => {
  assert.deepEqual(PERF_RANGES.map((r) => r.key), ['1h', '24h', '7d', '30d']);
  assert.equal(PERF_RANGES[0].label, 'Last Hour');
});

test('formatMs: ms below 1s, seconds above', () => {
  assert.equal(formatMs(950), '950ms');
  assert.equal(formatMs(2400), '2.4s');
  assert.equal(formatMs(0), '0ms');
});

test('sorting: numeric keys both directions, endpoint alphabetical, source not mutated', () => {
  const rows = [ep({ endpoint: 'B', avgMs: 100 }), ep({ endpoint: 'A', avgMs: 900 })] as never[];
  const byAvgDesc = sortEndpoints(rows, 'avgMs', 'desc');
  assert.equal(byAvgDesc[0].avgMs, 900);
  const byAvgAsc = sortEndpoints(rows, 'avgMs', 'asc');
  assert.equal(byAvgAsc[0].avgMs, 100);
  const byName = sortEndpoints(rows, 'endpoint', 'asc');
  assert.equal(byName[0].endpoint, 'A');
  assert.equal(rows[0].endpoint, 'B'); // untouched
});

test('search: case-insensitive endpoint filter; empty term returns all', () => {
  const rows = [ep({ endpoint: 'GET /api/v1/products' }), ep({ endpoint: 'POST /api/v1/checkout/order' })] as never[];
  assert.equal(filterEndpoints(rows, 'CHECKOUT').length, 1);
  assert.equal(filterEndpoints(rows, '').length, 2);
  assert.equal(filterEndpoints(rows, 'nope').length, 0);
});

test('latency tone thresholds for charts/cards', () => {
  assert.equal(latencyTone(100), 'ok');
  assert.equal(latencyTone(500), 'warn');
  assert.equal(latencyTone(1500), 'error');
});
