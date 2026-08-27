import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS, SEND_STATUSES, NOTIF_STATUS_BADGE, CHANNEL_BADGE, deliveryLabel, canResend, trendSeries,
  PROVIDERS, providerOf, buildTimeline, updatedAgoLabel, sanitizeFilters, retryableIds, clampDrawerWidth,
  DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_DEFAULT_WIDTH,
} from './notification-view.ts';

test('channels include future-ready PUSH and SMS alongside WhatsApp/Email', () => {
  assert.deepEqual([...CHANNELS], ['WHATSAPP', 'EMAIL', 'PUSH', 'SMS']);
  for (const c of CHANNELS) assert.ok(CHANNEL_BADGE[c]);
});

test('badges: SENT green, PENDING amber, FAILED red', () => {
  assert.match(NOTIF_STATUS_BADGE.SENT, /emerald/);
  assert.match(NOTIF_STATUS_BADGE.PENDING, /amber/);
  assert.match(NOTIF_STATUS_BADGE.FAILED, /red/);
  assert.deepEqual([...SEND_STATUSES], ['PENDING', 'SENT', 'FAILED']);
});

test('delivery duration label: null, seconds, minutes', () => {
  assert.equal(deliveryLabel(null), '—');
  assert.equal(deliveryLabel(12), '12s');
  assert.equal(deliveryLabel(90), '1m 30s');
});

test('resend button visibility mirrors the backend FAILED-only guard', () => {
  assert.equal(canResend('FAILED'), true);
  assert.equal(canResend('SENT'), false);
  assert.equal(canResend('PENDING'), false);
});

test('success trend series: per-day success %, zero-safe', () => {
  const series = trendSeries([
    { day: '2026-07-06', sent: 8, failed: 2 },
    { day: '2026-07-07', sent: 0, failed: 0 },
  ]);
  assert.deepEqual(series, [
    { label: '2026-07-06', value: 80 },
    { label: '2026-07-07', value: 0 },
  ]);
});

test('provider mapping: Qontak serves WhatsApp, Resend serves Email, none otherwise', () => {
  assert.equal(providerOf('WHATSAPP'), 'Qontak');
  assert.equal(providerOf('EMAIL'), 'Resend');
  assert.equal(providerOf('PUSH'), '—');
  assert.deepEqual(PROVIDERS.map((p) => p.value), ['QONTAK', 'RESEND']);
});

test('timeline: not yet picked up → Queued then pending Sending', () => {
  const steps = buildTimeline({ status: 'PENDING', attempts: 0, createdAt: '2026-07-08T01:00:00.000Z', sentAt: null, nextAttemptAt: '2026-07-08T01:00:05.000Z', lastError: null });
  assert.deepEqual(steps.map((s) => [s.label, s.tone]), [['Queued', 'ok'], ['Sending', 'pending']]);
});

test('timeline: first-attempt success → Queued, Sending, Sent', () => {
  const steps = buildTimeline({ status: 'SENT', attempts: 1, createdAt: '2026-07-08T01:00:00.000Z', sentAt: '2026-07-08T01:00:07.000Z', nextAttemptAt: null, lastError: null });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Sent']);
  assert.equal(steps.at(-1)?.at, '2026-07-08T01:00:07.000Z');
});

test('timeline: sent after two retries → Failed/Retry pairs then Sent', () => {
  const steps = buildTimeline({ status: 'SENT', attempts: 3, createdAt: '2026-07-08T01:00:00.000Z', sentAt: '2026-07-08T01:05:00.000Z', nextAttemptAt: null, lastError: null });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Failed', 'Retry #1', 'Failed', 'Retry #2', 'Sent']);
});

test('timeline: terminal failure carries the last error', () => {
  const steps = buildTimeline({ status: 'FAILED', attempts: 2, createdAt: '2026-07-08T01:00:00.000Z', sentAt: null, nextAttemptAt: null, lastError: 'HTTP 500' });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Failed', 'Retry #1', 'Failed']);
  assert.equal(steps.at(-1)?.tone, 'error');
  assert.equal(steps.at(-1)?.detail, 'HTTP 500');
});

test('timeline: pending mid-retry schedules the next retry step', () => {
  const steps = buildTimeline({ status: 'PENDING', attempts: 1, createdAt: '2026-07-08T01:00:00.000Z', sentAt: null, nextAttemptAt: '2026-07-08T01:02:00.000Z', lastError: 'timeout' });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Failed', 'Retry #1']);
  assert.equal(steps.at(-1)?.tone, 'pending');
  assert.equal(steps.at(-1)?.at, '2026-07-08T01:02:00.000Z');
});

test('updated-ago label: just now, seconds, minutes', () => {
  const now = 1_000_000_000;
  assert.equal(updatedAgoLabel(0, now), '—');
  assert.equal(updatedAgoLabel(now - 2_000, now), 'just now');
  assert.equal(updatedAgoLabel(now - 42_000, now), '42s ago');
  assert.equal(updatedAgoLabel(now - 3 * 60_000, now), '3m ago');
});

test('sanitizeFilters: keeps valid keys, drops junk and invalid enums', () => {
  const out = sanitizeFilters({
    channel: 'EMAIL', status: 'NOPE', provider: 'QONTAK', hasError: 'true',
    template: 'order.', retryMin: 2, durationMin: -1, durationMax: 30,
    search: '', evil: 'x', page: 99,
  });
  assert.deepEqual(out, { channel: 'EMAIL', provider: 'QONTAK', hasError: 'true', template: 'order.', retryMin: 2, durationMax: 30 });
  assert.deepEqual(sanitizeFilters(null), {});
  assert.deepEqual(sanitizeFilters('garbage'), {});
});

test('retryableIds: only selected FAILED rows are bulk-retryable', () => {
  const rows = [
    { id: 'a', status: 'FAILED' as const },
    { id: 'b', status: 'SENT' as const },
    { id: 'c', status: 'FAILED' as const },
  ];
  assert.deepEqual(retryableIds(rows, new Set(['a', 'b'])), ['a']);
  assert.deepEqual(retryableIds(rows, new Set(['a', 'c'])), ['a', 'c']);
  assert.deepEqual(retryableIds(rows, new Set()), []);
});

test('drawer width clamps into range and defaults on garbage', () => {
  assert.equal(clampDrawerWidth(100), DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(5000), DRAWER_MAX_WIDTH);
  assert.equal(clampDrawerWidth(600), 600);
  assert.equal(clampDrawerWidth(NaN), DRAWER_DEFAULT_WIDTH);
});
