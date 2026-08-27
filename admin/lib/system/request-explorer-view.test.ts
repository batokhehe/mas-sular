import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  segmentTimeline, eventStack, eventJson, expandState, statusTone, GROUP_BADGE, LEVEL_DOT,
} from './request-explorer-view.ts';

const ev = (over: Record<string, unknown> = {}) => ({
  id: 'e1', time: '2026-07-07T14:31:01.000Z', module: 'http', action: 'request.finished',
  group: 'SYSTEM', level: 'INFO', message: 'ok', durationMs: 12, statusCode: 200, metadata: null,
  ...over,
});

test('timeline rendering: consecutive same-group events form one segment, order preserved', () => {
  const events = [
    ev({ id: 'a', group: 'AUTH' }),
    ev({ id: 'b', group: 'ORDER' }),
    ev({ id: 'c', group: 'ORDER' }),
    ev({ id: 'd', group: 'SYSTEM' }),
  ];
  const segs = segmentTimeline(events as never);
  assert.deepEqual(segs.map((s) => s.group), ['AUTH', 'ORDER', 'SYSTEM']);
  assert.deepEqual(segs[1].events.map((e) => e.id), ['b', 'c']); // grouped in memory
});

test('a group reappearing later starts a NEW segment (chronology never re-sorted)', () => {
  const events = [ev({ id: 'a', group: 'ORDER' }), ev({ id: 'b', group: 'PAYMENT' }), ev({ id: 'c', group: 'ORDER' })];
  const segs = segmentTimeline(events as never);
  assert.deepEqual(segs.map((s) => s.group), ['ORDER', 'PAYMENT', 'ORDER']);
});

test('empty timeline → no segments (empty state)', () => {
  assert.deepEqual(segmentTimeline([]), []);
});

test('drawer: eventStack extracts metadata.stack; null when absent', () => {
  assert.equal(eventStack(ev({ metadata: { stack: 'Error: boom\n  at x' } }) as never), 'Error: boom\n  at x');
  assert.equal(eventStack(ev() as never), null);
  assert.equal(eventStack(ev({ metadata: { stack: 42 } }) as never), null);
});

test('copy buttons: eventJson serializes the full event as pretty JSON', () => {
  const json = eventJson(ev({ metadata: { orderId: 'o1' } }) as never);
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, 'e1');
  assert.equal(parsed.metadata.orderId, 'o1');
  assert.ok(json.includes('\n  ')); // pretty-printed for humans
});

test('expand/collapse: expandState toggles every segment at once', () => {
  assert.deepEqual(expandState(3, true), { 0: true, 1: true, 2: true });
  assert.deepEqual(expandState(2, false), { 0: false, 1: false });
});

test('status tone + colors: levels and groups all mapped', () => {
  assert.equal(statusTone(200), 'ok');
  assert.equal(statusTone(404), 'warn');
  assert.equal(statusTone(500), 'error');
  assert.equal(statusTone(null), 'muted');
  for (const level of ['INFO', 'WARN', 'ERROR', 'DEBUG'] as const) assert.ok(LEVEL_DOT[level]);
  for (const g of ['AUTH', 'ORDER', 'PAYMENT', 'INVENTORY', 'SHIPMENT', 'NOTIFICATION', 'WORKER', 'SYSTEM'] as const) assert.ok(GROUP_BADGE[g]);
});
