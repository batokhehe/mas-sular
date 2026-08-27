import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_TABS, HEALTH_BADGE, HEALTH_LABEL, statusBadge, formatAge, relatedLinks, rowJson,
} from './queue-center-view.ts';

test('tabs: all five queue-center tabs defined in order', () => {
  assert.deepEqual([...QUEUE_TABS], ['Outbox', 'Notifications', 'RabbitMQ', 'Workers', 'Failed']);
});

test('health badge + label cover every health level', () => {
  for (const h of ['green', 'yellow', 'red'] as const) {
    assert.ok(HEALTH_BADGE[h]);
    assert.ok(HEALTH_LABEL[h]);
  }
  assert.equal(HEALTH_LABEL.green, 'Healthy');
});

test('status badge tones: success green, failed red, pending amber', () => {
  assert.match(statusBadge('PUBLISHED'), /emerald/);
  assert.match(statusBadge('SENT'), /emerald/);
  assert.match(statusBadge('FAILED'), /red/);
  assert.match(statusBadge('PENDING'), /amber/);
});

test('formatAge: seconds → minutes → hours → days', () => {
  assert.equal(formatAge(42_000), '42s');
  assert.equal(formatAge(12 * 60_000), '12m');
  assert.equal(formatAge(3 * 3_600_000), '3h');
  assert.equal(formatAge(5 * 86_400_000), '5d');
  assert.equal(formatAge(-5), '0s'); // clock skew never renders negative
});

test('relatedLinks: builds drawer links only for present refs (order number preferred)', () => {
  const links = relatedLinks({ requestId: 'req-1', orderId: 'o1', orderNumber: 'BMS-1', paymentId: null, shipmentId: null });
  assert.deepEqual(links.map((l) => l.label), ['Request', 'Order']);
  assert.equal(links[1].id, 'BMS-1'); // shows the human order number
  assert.equal(links[0].href, '/system/requests/req-1');
  assert.deepEqual(relatedLinks({ requestId: null, orderId: null, orderNumber: null, paymentId: null, shipmentId: null }), []);
});

test('relatedLinks: customer ref links to the admin user page', () => {
  const links = relatedLinks({ requestId: null, orderId: null, orderNumber: null, paymentId: null, shipmentId: null, customerId: 'u-9' });
  assert.deepEqual(links, [{ label: 'Customer', href: '/users/u-9', id: 'u-9' }]);
});

test('copy/download: rowJson pretty-prints the full row', () => {
  const json = rowJson({ id: 'evt-1', payload: { orderId: 'o1' } });
  const parsed = JSON.parse(json);
  assert.equal(parsed.payload.orderId, 'o1');
  assert.ok(json.includes('\n  '));
});
