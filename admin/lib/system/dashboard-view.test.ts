import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryCards, successRate, failureRate, errorBars, WORKER_DOT, WORKER_LABEL } from './dashboard-view.ts';

// Minimal backend-shaped payload fixture.
const payload = {
  summary: { totalRequestsToday: 1200, avgResponseTimeMs: 42, errorRatePct: 6, warningsToday: 3, errorsToday: 9, activeWorkers: 2, pendingNotifications: 4, pendingQueue: 7 },
  requestMetrics: { perHour: [], p95Ms: 0, topEndpoints: [], slowestEndpoints: [] },
  errorMetrics: { byHour: [{ hour: 'x', count: 5 }, { hour: 'y', count: 2 }], byModule: [], byAction: [], topRecurring: [] },
  queueMetrics: { outbox: {}, notification: {} },
  notificationMetrics: {},
  workerMetrics: [],
  databaseMetrics: {},
  cacheMetrics: {},
  generatedAt: '',
};

test('summaryCards renders 8 KPI cards from backend values (no calculation)', () => {
  const cards = summaryCards(payload as never);
  assert.equal(cards.length, 8);
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(byKey.requests.value, '1.200'); // id-ID grouping of backend value
  assert.equal(byKey.avg.value, '42ms');
  assert.equal(byKey.errorRate.value, '6%');
});

test('error-rate tone escalates: >=5% error, >1% warn, else ok', () => {
  const tone = (pct: number) => summaryCards({ ...payload, summary: { ...payload.summary, errorRatePct: pct } } as never).find((c) => c.key === 'errorRate')!.tone;
  assert.equal(tone(6), 'error');
  assert.equal(tone(2), 'warn');
  assert.equal(tone(0), 'ok');
});

test('empty payload → all KPI values are zero', () => {
  const empty = { ...payload, summary: { totalRequestsToday: 0, avgResponseTimeMs: 0, errorRatePct: 0, warningsToday: 0, errorsToday: 0, activeWorkers: 0, pendingNotifications: 0, pendingQueue: 0 } };
  const cards = summaryCards(empty as never);
  assert.ok(cards.every((c) => c.value === '0' || c.value === '0ms' || c.value === '0%'));
});

test('notification success/failure rates (display-only)', () => {
  assert.equal(successRate({ success: 80, failed: 20 }), 80);
  assert.equal(failureRate({ success: 80, failed: 20 }), 20);
  assert.equal(successRate({ success: 0, failed: 0 }), 0); // no traffic
});

test('errorBars maps hourly counts to a numeric series for the chart', () => {
  assert.deepEqual(errorBars(payload.errorMetrics.byHour as never), [5, 2]);
});

test('worker status colors + labels cover every health level', () => {
  for (const s of ['green', 'yellow', 'red', 'gray'] as const) {
    assert.ok(WORKER_DOT[s]);
    assert.ok(WORKER_LABEL[s]);
  }
  assert.equal(WORKER_LABEL.gray, 'Disabled');
});
