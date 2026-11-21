import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildReconcilePayload, capturedAwb, EMPTY_RECONCILE_FORM, needsReconciliation, RECONCILE_GUIDANCE } from './reconcile.ts';
import type { ReconcileForm } from './reconcile.ts';

/**
 * Admin reconciliation of an UNKNOWN shipment. The server is authoritative; this
 * pins that the form sends exactly what the dedicated endpoint needs, refuses what it
 * would refuse, and that Order Detail no longer tells operators to edit the status.
 */

const AWB = 'CO.EMSULAR-20261121-7-ABCDEF';
const META_WITH_AWB = { reconciliationRequired: true, booking: { unrecorded: { provider: 'paxel', trackingNumber: AWB, providerShipmentId: AWB } } };
const form = (over: Partial<ReconcileForm>): ReconcileForm => ({ ...EMPTY_RECONCILE_FORM, ...over });

test('needsReconciliation: only UNKNOWN without an airwaybill', () => {
  assert.equal(needsReconciliation({ status: 'UNKNOWN', trackingNumber: null }), true);
  assert.equal(needsReconciliation({ status: 'UNKNOWN', trackingNumber: '0291' }), false);
  for (const status of ['FAILED', 'PENDING', 'RATE_SELECTED', 'CREATED']) assert.equal(needsReconciliation({ status }), false);
  assert.equal(needsReconciliation(null), false);
});

test('capturedAwb reads metadata.booking.unrecorded and tolerates anything else', () => {
  assert.deepEqual(capturedAwb(META_WITH_AWB), { trackingNumber: AWB, provider: 'paxel' });
  for (const junk of [null, undefined, 'x', [], {}, { booking: null }, { booking: { unrecorded: { trackingNumber: '' } } }]) {
    assert.equal(capturedAwb(junk), null);
  }
});

test('an outcome must be chosen', () => {
  assert.equal(buildReconcilePayload(EMPTY_RECONCILE_FORM, null).ok, false);
});

test('booked: needs a valid AWB, and the captured one when the courier already issued it', () => {
  assert.equal(buildReconcilePayload(form({ outcome: 'booked', trackingNumber: 'a b' }), null).ok, false);
  const other = buildReconcilePayload(form({ outcome: 'booked', trackingNumber: 'CO.EMSULAR-20261121-8-OTHER1' }), capturedAwb(META_WITH_AWB));
  assert.equal(other.ok, false);
  assert.match((other as { errors: string[] }).errors.join(' '), /CO\.EMSULAR-20261121-7-ABCDEF/);
  assert.deepEqual(buildReconcilePayload(form({ outcome: 'booked', trackingNumber: ` ${AWB} `, note: ' cek dashboard ' }), capturedAwb(META_WITH_AWB)), {
    ok: true,
    payload: { outcome: 'booked', trackingNumber: AWB, note: 'cek dashboard' },
  });
});

test('not_booked: refused without the courier confirmation or its reference', () => {
  for (const over of [
    {},
    { confirmNoActiveBooking: true },
    { courierCheckReference: 'CS #48213' },
    { confirmNoActiveBooking: true, courierCheckReference: '  ' },
    { confirmNoActiveBooking: true, courierCheckReference: 'x'.repeat(201) },
  ]) {
    assert.equal(buildReconcilePayload(form({ outcome: 'not_booked', ...over }), null).ok, false, JSON.stringify(over));
  }
});

test('not_booked: a known AWB must be cancelled with the courier first', () => {
  const evidence = { outcome: 'not_booked' as const, confirmNoActiveBooking: true, courierCheckReference: 'CS #48213' };
  const refused = buildReconcilePayload(form(evidence), capturedAwb(META_WITH_AWB));
  assert.equal(refused.ok, false);
  assert.match((refused as { errors: string[] }).errors.join(' '), /AWB CO\.EMSULAR-20261121-7-ABCDEF sudah diterbitkan kurir\. Batalkan AWB tersebut ke kurir terlebih dahulu/);
  assert.deepEqual(buildReconcilePayload(form({ ...evidence, cancelledAtCourier: true }), capturedAwb(META_WITH_AWB)), {
    ok: true,
    payload: { outcome: 'not_booked', confirmNoActiveBooking: true, courierCheckReference: 'CS #48213', cancelledAtCourier: true },
  });
});

test('not_booked with the courier evidence produces exactly the endpoint body', () => {
  assert.deepEqual(buildReconcilePayload(form({ outcome: 'not_booked', confirmNoActiveBooking: true, courierCheckReference: ' JNE CS 48213 ' }), null), {
    ok: true,
    payload: { outcome: 'not_booked', confirmNoActiveBooking: true, courierCheckReference: 'JNE CS 48213' },
  });
});

test('guidance says a timeout is not evidence and to cancel a known AWB first', () => {
  assert.match(RECONCILE_GUIDANCE.notBooked, /BUKAN bukti/);
  assert.match(RECONCILE_GUIDANCE.cancelFirst(AWB), /batalkan AWB CO\.EMSULAR-20261121-7-ABCDEF ke kurir terlebih dahulu/);
  assert.match(RECONCILE_GUIDANCE.intro, /jangan ubah status pengiriman secara manual/);
});

test('Order Detail: no manual status-change instruction; UNKNOWN gets the reconcile action, never Retry', () => {
  const page = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'orders', '[id]', 'page.tsx'), 'utf8');
  assert.doesNotMatch(page, /ubah status pengiriman menjadi Gagal/i);
  assert.doesNotMatch(page, /agar dapat dicoba ulang/i);
  assert.match(page, /<ReconcileShipmentAction /);
  assert.match(page, /actions\?\.retryShipment && !needsReconciliation\(order\.shipment\)/);

  const component = readFileSync(join(import.meta.dirname, '..', '..', 'components', 'orders', 'reconcile-shipment.tsx'), 'utf8');
  // The action talks to the dedicated endpoint only - never the generic shipment edit or Retry.
  assert.match(component, /reconcileShipment\(orderId, input\)/);
  assert.doesNotMatch(component, /updateAdminShipment|retryShipment/);
});
