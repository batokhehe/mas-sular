import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEVERITY_BADGE, STATUS_BADGE, incidentDuration, incidentLinks, incidentActions } from './incident-view.ts';

test('badges: spec colors — critical red, high orange, medium yellow, low blue, info gray', () => {
  assert.match(SEVERITY_BADGE.CRITICAL, /red/);
  assert.match(SEVERITY_BADGE.HIGH, /orange/);
  assert.match(SEVERITY_BADGE.MEDIUM, /amber/);
  assert.match(SEVERITY_BADGE.LOW, /blue/);
  assert.match(SEVERITY_BADGE.INFO, /gray/);
  assert.match(STATUS_BADGE.OPEN, /red/);
  assert.match(STATUS_BADGE.ACKNOWLEDGED, /amber/);
  assert.match(STATUS_BADGE.RESOLVED, /emerald/);
});

test('duration: firstSeen → lastSeen humanized (s/m/h/d)', () => {
  assert.equal(incidentDuration('2026-07-07T10:00:00Z', '2026-07-07T10:00:42Z'), '42s');
  assert.equal(incidentDuration('2026-07-07T10:00:00Z', '2026-07-07T10:12:00Z'), '12m');
  assert.equal(incidentDuration('2026-07-07T10:00:00Z', '2026-07-07T13:30:00Z'), '3h 30m');
  assert.equal(incidentDuration('2026-07-05T10:00:00Z', '2026-07-07T12:00:00Z'), '2d 2h');
  assert.equal(incidentDuration('2026-07-07T10:00:00Z', '2026-07-07T09:00:00Z'), '0s'); // never negative
});

test('drawer related links only for present refs', () => {
  const links = incidentLinks({ requestId: 'req-1', orderId: 'o1', paymentId: null, shipmentId: null } as never);
  assert.deepEqual(links.map((l) => l.label), ['Request', 'Order']);
  assert.equal(links[0].href, '/system/requests/req-1');
  assert.deepEqual(incidentLinks({} as never), []);
});

test('filter/action visibility follows status', () => {
  assert.deepEqual(incidentActions('OPEN'), { canAcknowledge: true, canResolve: true });
  assert.deepEqual(incidentActions('ACKNOWLEDGED'), { canAcknowledge: false, canResolve: true });
  assert.deepEqual(incidentActions('RESOLVED'), { canAcknowledge: false, canResolve: false });
});
