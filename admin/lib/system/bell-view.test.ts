import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BELL_FILTERS, PRIORITY_DOT, relativeTime, groupByDay, reduceUnread, badgeLabel } from './bell-view.ts';

const NOW = new Date('2026-07-09T12:00:00Z');
const n = (id: string, iso: string, over: Record<string, unknown> = {}) => ({
  id, eventType: 'x', category: 'ORDER', priority: 'HIGH', title: 'T', message: 'M',
  url: null, icon: null, isRead: false, readAt: null, createdAt: iso, ...over,
});

test('relative time: just now / minutes / hours / days / date fallback', () => {
  assert.equal(relativeTime('2026-07-09T11:59:30Z', NOW), 'just now');
  assert.equal(relativeTime('2026-07-09T11:55:00Z', NOW), '5m ago');
  assert.equal(relativeTime('2026-07-09T09:00:00Z', NOW), '3h ago');
  assert.equal(relativeTime('2026-07-07T12:00:00Z', NOW), '2d ago');
  assert.match(relativeTime('2026-06-01T00:00:00Z', NOW), /2026|06|6/);
});

test('drawer grouping: Today / Yesterday / Older, empty groups dropped', () => {
  const groups = groupByDay(
    [n('a', '2026-07-09T10:00:00Z'), n('b', '2026-07-08T10:00:00Z'), n('c', '2026-07-01T10:00:00Z')] as never[],
    NOW,
  );
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', 'Older']);
  assert.equal(groups[0].items[0].id, 'a');
  const onlyToday = groupByDay([n('a', '2026-07-09T10:00:00Z')] as never[], NOW);
  assert.deepEqual(onlyToday.map((g) => g.label), ['Today']);
});

test('counter reducer: created increments, read decrements, read-all zeroes (multi-tab sync)', () => {
  assert.equal(reduceUnread(3, { type: 'notification.created' }), 4);
  assert.equal(reduceUnread(3, { type: 'notification.read', readId: 'n1' }), 2);
  assert.equal(reduceUnread(0, { type: 'notification.read', readId: 'n1' }), 0); // never negative
  assert.equal(reduceUnread(7, { type: 'notification.read', readId: 'all' }), 0);
  assert.equal(reduceUnread(5, { type: 'heartbeat' }), 5);
});

test('bell badge: hidden at zero, capped at 99+', () => {
  assert.equal(badgeLabel(0), null);
  assert.equal(badgeLabel(7), '7');
  assert.equal(badgeLabel(250), '99+');
});

test('filters cover the spec categories; priorities all have dots', () => {
  assert.deepEqual(BELL_FILTERS.map((f) => f.label), ['All', 'Unread', 'Orders', 'Payments', 'Inventory', 'System', 'Security', 'Audit']);
  for (const p of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const) assert.ok(PRIORITY_DOT[p]);
});
