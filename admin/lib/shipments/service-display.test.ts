import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipmentServiceDisplay, shipmentServiceSearchTerms } from './service-display.ts';

/**
 * The Admin Shipping page used to render Shipment.service raw. That field is a
 * snapshot: checkout writes the display label into it, and nothing keeps it in
 * step with the order. These pin the authoritative precedence, and — just as
 * importantly — that HISTORICAL rows still render without being migrated.
 */

test('prefers the label the customer was quoted', () => {
  const shipment = {
    service: 'Paxel Same Day',
    order: { shippingServiceName: 'Paxel Instant', shippingService: 'PAXEL_INSTANT' },
  };
  assert.equal(shipmentServiceDisplay(shipment), 'Paxel Instant');
});

test('falls back to the paid machine code when no label was stored', () => {
  const shipment = {
    service: 'Paxel Same Day',
    order: { shippingServiceName: null, shippingService: 'PAXEL_INSTANT' },
  };
  assert.equal(shipmentServiceDisplay(shipment), 'PAXEL_INSTANT');
});

test('a stale shipment snapshot never wins over the order', () => {
  // The exact corruption PAXELBOX-18 withdrew the override to prevent.
  const shipment = {
    service: 'PAXEL_NEXTDAY',
    order: { shippingServiceName: null, shippingService: 'PAXEL_INSTANT' },
  };
  assert.equal(shipmentServiceDisplay(shipment), 'PAXEL_INSTANT');
});

test('a legacy row with no order service still renders, unmigrated', () => {
  const shipment = { service: 'JNE Reguler (Mock)', order: { shippingServiceName: null, shippingService: null } };
  assert.equal(shipmentServiceDisplay(shipment), 'JNE Reguler (Mock)');
});

test('a JNE order shows its own code, never a Paxel service', () => {
  const shipment = { service: 'JNE Reguler (Mock)', order: { shippingServiceName: null, shippingService: 'REG' } };
  const shown = shipmentServiceDisplay(shipment);
  assert.equal(shown, 'REG');
  assert.notEqual(shown, 'PAXEL_REGULAR');
});

test('nothing at all renders as a dash rather than blank or undefined', () => {
  assert.equal(shipmentServiceDisplay({ service: null, order: null }), '-');
  assert.equal(shipmentServiceDisplay({}), '-');
});

test('search matches the label, the code and the legacy snapshot', () => {
  const shipment = {
    service: 'Paxel Same Day',
    order: { shippingServiceName: 'Paxel Instant', shippingService: 'PAXEL_INSTANT' },
  };
  const terms = shipmentServiceSearchTerms(shipment);
  assert.deepEqual(terms, ['Paxel Instant', 'PAXEL_INSTANT', 'Paxel Same Day']);
  // An operator who remembers either representation still finds the row.
  for (const needle of ['instant', 'PAXEL_INSTANT', 'Same Day']) {
    assert.ok(terms.some((t) => t.toLowerCase().includes(needle.toLowerCase())), needle);
  }
});

test('search terms drop empties so a blank query cannot match everything', () => {
  const terms = shipmentServiceSearchTerms({ service: 'REG', order: { shippingServiceName: null, shippingService: null } });
  assert.deepEqual(terms, ['REG']);
  assert.deepEqual(shipmentServiceSearchTerms({ service: null, order: null }), []);
});
