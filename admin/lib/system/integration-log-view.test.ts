import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contextLabel,
  formatAttempt,
  formatDuration,
  hasPayload,
  httpStatusTone,
  INTEGRATION_OPERATIONS,
  INTEGRATION_OUTCOMES,
  INTEGRATION_PROVIDERS,
  operationOptions,
  outcomeTone,
  prettyPayload,
} from './integration-log-view.ts';
import { ROUTE_PERMISSIONS } from '../access.ts';

/**
 * Admin → System → Integration Logs (P1). The page follows the System Logs
 * architecture: filters + table + detail drawer, payloads collapsed by default.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

test('provider vocabulary is the providers\' own, not a normalized one', () => {
  assert.deepEqual(INTEGRATION_PROVIDERS, ['PAXEL', 'JNE', 'MIDTRANS']);
  // JNE books through /pickupcashless now; GENERATE_CNOTE stays filterable for historical records.
  assert.deepEqual(INTEGRATION_OPERATIONS.JNE, ['RATE', 'PICKUP_CASHLESS', 'GENERATE_CNOTE', 'CANCEL_CNOTE', 'TRACK', 'WEBHOOK']);
  assert.deepEqual(INTEGRATION_OPERATIONS.MIDTRANS, ['charge', 'status', 'cancel', 'expire', 'WEBHOOK']);
  assert.deepEqual(INTEGRATION_OPERATIONS.PAXEL, ['RATE', 'CREATE_SHIPMENT', 'CANCEL', 'TRACK', 'WEBHOOK']);
});

test('the operation filter narrows to the selected provider', () => {
  assert.deepEqual(operationOptions('JNE'), INTEGRATION_OPERATIONS.JNE);
  const all = operationOptions('');
  for (const op of ['PICKUP_CASHLESS', 'GENERATE_CNOTE', 'charge', 'CREATE_SHIPMENT', 'WEBHOOK']) assert.ok(all.includes(op));
  assert.equal(new Set(all).size, all.length, 'no duplicates across providers');
});

test('outcome and status tones: OK green, provider refusal amber, breakage red', () => {
  assert.equal(outcomeTone('OK'), 'ok');
  assert.equal(outcomeTone('REJECTED'), 'warn');
  for (const o of ['HTTP_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'PARSE_FAILED'] as const) assert.equal(outcomeTone(o), 'error');
  assert.equal(INTEGRATION_OUTCOMES.length, 6);

  assert.equal(httpStatusTone(200), 'ok');
  assert.equal(httpStatusTone(404), 'warn');
  assert.equal(httpStatusTone(500), 'error');
  assert.equal(httpStatusTone(null), 'none');
});

test('duration, attempt and context formatting', () => {
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(312), '312ms');
  assert.equal(formatDuration(1500), '1.50s');
  assert.equal(formatDuration(3195), '3.19s'); // the JNE generatecnote latency from the report

  assert.equal(formatAttempt({ attempt: 2, maxAttempts: 3 }), '2 of 3');
  assert.equal(formatAttempt({ attempt: 1, maxAttempts: null }), '1');
  // The application-outcome record has no attempt of its own.
  assert.equal(formatAttempt({ attempt: null, maxAttempts: null }), 'result');

  assert.equal(contextLabel({ correlationId: 'BMS-1', orderId: 'o1', paymentId: null, shipmentId: null }), 'BMS-1');
  assert.equal(contextLabel({ correlationId: null, orderId: 'o1', paymentId: null, shipmentId: null }), 'o1');
  assert.equal(contextLabel({ correlationId: null, orderId: null, paymentId: null, shipmentId: null }), '—');
});

test('payload helpers', () => {
  assert.equal(hasPayload(null), false);
  assert.equal(hasPayload({}), false);
  assert.equal(hasPayload({ a: 1 }), true);
  assert.equal(hasPayload('text'), true);
  assert.equal(prettyPayload(null), '(empty)');
  assert.equal(prettyPayload({ a: 1 }), '{\n  "a": 1\n}');
});

test('the page is gated by IntegrationLog.read and registered in the System menu', () => {
  assert.deepEqual(ROUTE_PERMISSIONS.integrationLogs, ['IntegrationLog.read']);
  const page = read('app/system/integration-logs/page.tsx');
  assert.match(page, /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.integrationLogs\}>/);
  assert.match(read('lib/navigation.ts'), /\{ href: '\/system\/integration-logs', label: 'Integration Logs', icon: 'integrations', permissions: ROUTE_PERMISSIONS\.integrationLogs \}/);
  assert.match(read('components/layout/sidebar.tsx'), /integrations: Plug,/);
});

test('the list shows the documented columns and the drawer the documented context', () => {
  const page = read('app/system/integration-logs/page.tsx');
  for (const column of ['Time', 'Provider', 'Operation', 'Direction', 'HTTP', 'Duration', 'Order', 'Outcome']) {
    assert.match(page, new RegExp(`<th className="py-3 font-medium">${column}</th>`), `column ${column}`);
  }
  for (const field of ['Operation ID', 'Request ID', 'Correlation ID', 'Order ID', 'Payment ID', 'Shipment ID', 'Attempt', 'Duration']) {
    assert.match(page, new RegExp(`<Field label="${field}"`), `context field ${field}`);
  }
  assert.match(page, /<Payload title="Sanitized request payload" value=\{log\.sanitizedRequest\} \/>/);
  assert.match(page, /<Payload title="Sanitized response payload" value=\{log\.sanitizedResponse\} \/>/);
});

test('payloads are collapsed by default (a <details> without `open`)', () => {
  const page = read('app/system/integration-logs/page.tsx');
  assert.match(page, /<details className="mt-2 rounded-lg border border-gray-100">/);
  assert.doesNotMatch(page, /<details open/);
});

test('the client calls the admin endpoint and keeps the repository pagination envelope', () => {
  const client = read('lib/admin.ts');
  assert.match(client, /api<Paginated<IntegrationLog>>\(`\/admin\/integration-logs\$\{query \? `\?\$\{query\}` : ''\}`\)/);
  assert.match(client, /api<IntegrationLog>\(`\/admin\/integration-logs\/\$\{id\}`\)/);
  // The per-operation route exists and is tested on the API side; the admin client
  // deliberately carries no helper for it until a page actually calls one.
  assert.doesNotMatch(client, /integration-logs\/operations/);
});
