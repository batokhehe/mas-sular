import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationItem } from '@/lib/admin';
import {
  MANUAL_SEND_TEMPLATES, historyBadges, deliveryTimeline, conversationGroups, templateLabel, idr,
} from './communication-view.ts';

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    id: 'n1', createdAt: '2026-07-08T01:00:00.000Z', sentAt: null, nextAttemptAt: null,
    channel: 'WHATSAPP', status: 'PENDING', template: 'order.transfer', recipient: '628123',
    attempts: 0, lastError: null, providerMessageId: null, deliverySec: null, subject: null,
    isManual: false, resendAt: null, stage: null, statusLabel: null,
    related: { requestId: null, orderId: null, orderNumber: null, paymentId: null, shipmentId: null },
    ...overrides,
  };
}

test('manual send templates: order/shipment/custom with correct extra fields', () => {
  assert.deepEqual(MANUAL_SEND_TEMPLATES.map((t) => t.value), ['manual.order-update', 'manual.shipment-update', 'manual.custom']);
  assert.equal(MANUAL_SEND_TEMPLATES[0].needsOrderNumber, true);
  assert.equal(MANUAL_SEND_TEMPLATES[2].needsSubject, true);
  assert.equal(MANUAL_SEND_TEMPLATES[2].needsOrderNumber, false);
});

test('history badges: success/failed/queued outcome + manual/auto origin', () => {
  assert.deepEqual(historyBadges({ status: 'SENT', attempts: 1, isManual: false, resendAt: null }).map((b) => b.label), ['Success', 'Auto']);
  assert.deepEqual(historyBadges({ status: 'FAILED', attempts: 1, isManual: true, resendAt: null }).map((b) => b.label), ['Failed', 'Manual']);
  assert.deepEqual(historyBadges({ status: 'PENDING', attempts: 0, isManual: false, resendAt: null }).map((b) => b.label), ['Queued', 'Auto']);
});

test('history badges: retry and resend markers are additive', () => {
  const labels = historyBadges({ status: 'SENT', attempts: 3, isManual: false, resendAt: '2026-07-08T02:00:00.000Z' }).map((b) => b.label);
  assert.deepEqual(labels, ['Success', 'Retry ×2', 'Resend', 'Auto']);
});

test('delivery timeline: happy path ends with Provider Accepted then Delivered', () => {
  const steps = deliveryTimeline({
    status: 'SENT', attempts: 1, createdAt: '2026-07-08T01:00:00.000Z', sentAt: '2026-07-08T01:00:09.000Z',
    nextAttemptAt: null, lastError: null, providerMessageId: 'prov-1',
  });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Provider Accepted', 'Delivered']);
  assert.equal(steps[2].at, '2026-07-08T01:00:09.000Z');
  assert.match(steps[2].detail ?? '', /prov-1/);
});

test('delivery timeline: retry chain then failure carries the error', () => {
  const steps = deliveryTimeline({
    status: 'FAILED', attempts: 2, createdAt: '2026-07-08T01:00:00.000Z', sentAt: null,
    nextAttemptAt: null, lastError: 'HTTP 500', providerMessageId: null,
  });
  assert.deepEqual(steps.map((s) => s.label), ['Queued', 'Sending', 'Failed', 'Retry #1', 'Failed']);
  assert.equal(steps.at(-1)?.detail, 'HTTP 500');
});

test('delivery timeline: pending retry is scheduled with a timestamp', () => {
  const steps = deliveryTimeline({
    status: 'PENDING', attempts: 1, createdAt: '2026-07-08T01:00:00.000Z', sentAt: null,
    nextAttemptAt: '2026-07-08T01:05:00.000Z', lastError: 'timeout', providerMessageId: null,
  });
  assert.equal(steps.at(-1)?.label, 'Retry #1');
  assert.equal(steps.at(-1)?.at, '2026-07-08T01:05:00.000Z');
  assert.equal(steps.at(-1)?.tone, 'pending');
});

test('conversation groups: order preferred, then payment/shipment, else General; order preserved', () => {
  const items = [
    item({ id: 'a', related: { requestId: null, orderId: 'o1', orderNumber: 'BMS-1', paymentId: null, shipmentId: null } }),
    item({ id: 'b', related: { requestId: null, orderId: null, orderNumber: null, paymentId: 'p1', shipmentId: null } }),
    item({ id: 'c', related: { requestId: null, orderId: 'o1', orderNumber: 'BMS-1', paymentId: 'p1', shipmentId: null } }),
    item({ id: 'd', related: { requestId: null, orderId: null, orderNumber: null, paymentId: null, shipmentId: null } }),
  ];
  const groups = conversationGroups(items);
  assert.deepEqual(groups.map((g) => [g.kind, g.label, g.items.map((i) => i.id)]), [
    ['order', 'Order BMS-1', ['a', 'c']],
    ['payment', 'Payment p1', ['b']],
    ['general', 'General', ['d']],
  ]);
});

test('template labels: journey names match the spec example', () => {
  assert.equal(templateLabel({ template: 'order.transfer', stage: null, statusLabel: null, isManual: false }), 'Order Created — Waiting Payment');
  assert.equal(templateLabel({ template: 'payment.reminder', stage: 'first', statusLabel: null, isManual: false }), 'Payment Reminder (24h)');
  assert.equal(templateLabel({ template: 'payment.reminder', stage: 'second', statusLabel: null, isManual: false }), 'Payment Reminder (48h)');
  assert.equal(templateLabel({ template: 'payment.receipt_uploaded', stage: null, statusLabel: null, isManual: false }), 'Payment Uploaded');
  assert.equal(templateLabel({ template: 'payment.approved', stage: null, statusLabel: null, isManual: false }), 'Payment Verified');
  assert.equal(templateLabel({ template: 'order.shipped', stage: null, statusLabel: null, isManual: false }), 'Shipped');
  assert.equal(templateLabel({ template: 'order.delivered', stage: null, statusLabel: null, isManual: false }), 'Delivered');
  assert.equal(templateLabel({ template: 'shipment.status', stage: null, statusLabel: 'sedang diantar', isManual: false }), 'Shipment: sedang diantar');
  assert.equal(templateLabel({ template: 'manual.custom', stage: null, statusLabel: null, isManual: true }), 'Manual Message');
  assert.equal(templateLabel({ template: 'weird.template', stage: null, statusLabel: null, isManual: false }), 'weird.template');
});

test('idr: rupiah formatting with id-ID separators', () => {
  assert.equal(idr(0), 'Rp 0');
  assert.equal(idr(1500000), `Rp ${(1500000).toLocaleString('id-ID')}`);
});
