import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contextLabel,
  exactBody,
  exactEndpoint,
  formatAttempt,
  formatDuration,
  httpStatusTone,
  INTEGRATION_OPERATIONS,
  INTEGRATION_OUTCOMES,
  INTEGRATION_PROVIDERS,
  operationOptions,
  outcomeTone,
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

test('exact bodies are returned byte-for-byte: no masking, pretty-printing, trimming or truncation', () => {
  const form = 'username=TESTAPI&api_key=0123456789abcdef0123456789abcdef&RECEIVER_PHONE=6285861470308&SERVICE_CODE=JTR%3C130&SPECIAL_INS=NO+SPECIAL+INSTRUCTION';
  assert.deepEqual(exactBody(form), { captured: true, empty: false, text: form });
  const jne = '{\n  "error" : "Please do not let paramaters empty.",\n  "status" : false\n}';
  assert.equal((exactBody(jne) as { text: string }).text, jne); // JNE's own spacing kept
  const padded = '  {"a":1}\n\n';
  assert.equal((exactBody(padded) as { text: string }).text, padded);
  const large = 'x'.repeat(200_000);
  assert.equal((exactBody(large) as { text: string }).text.length, 200_000);
  assert.deepEqual(exactBody(''), { captured: true, empty: true, text: '' });
  assert.deepEqual(exactBody(null), { captured: false });
  assert.deepEqual(exactBody(undefined), { captured: false });
});

test('the URL shown is the exact one when captured', () => {
  assert.equal(exactEndpoint({ rawEndpoint: 'https://apiv2.jne.co.id:10202/pickupcashless?x=secret', endpoint: 'https://apiv2.jne.co.id:10202/pickupcashless?x=[REDACTED]' }), 'https://apiv2.jne.co.id:10202/pickupcashless?x=secret');
  assert.equal(exactEndpoint({ rawEndpoint: null, endpoint: 'https://jne.test/x' }), 'https://jne.test/x');
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
  // The drawer shows the exchange EXACTLY as captured - never the sanitized copies.
  assert.match(page, /<ExactPayload title="Request body" value=\{log\.rawRequestBody\} \/>/);
  assert.match(page, /<ExactPayload title="Response body" value=\{log\.rawResponseBody\} \/>/);
  assert.match(page, /<Field label="URL" value=\{<span className="break-all font-mono text-xs">\{exactEndpoint\(log\) \?\? '—'\}<\/span>\} \/>/);
  assert.doesNotMatch(page, /sanitizedRequest|sanitizedResponse|prettyPayload|JSON\.stringify/);
  // Rendered verbatim: whitespace preserved, the text itself untouched.
  assert.match(page, /whitespace-pre-wrap break-all rounded-b-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">\{body\.text\}<\/pre>/);
});

test('payloads are collapsed by default (a <details> without `open`)', () => {
  const page = read('app/system/integration-logs/page.tsx');
  assert.match(page, /<details className="mt-2 rounded-lg border border-gray-100">/);
  assert.doesNotMatch(page, /<details open/);
});

test('the client calls the admin endpoint and keeps the repository pagination envelope', () => {
  const client = read('lib/admin.ts');
  assert.match(client, /api<Paginated<IntegrationLog>>\(`\/admin\/integration-logs\$\{query \? `\?\$\{query\}` : ''\}`\)/);
  assert.match(client, /api<IntegrationLogDetail>\(`\/admin\/integration-logs\/\$\{id\}`\)/);
  assert.match(client, /rawEndpoint: string \| null;\s+rawRequestBody: string \| null;\s+rawResponseBody: string \| null;/);
  // The per-operation route exists and is tested on the API side; the admin client
  // deliberately carries no helper for it until a page actually calls one.
  assert.doesNotMatch(client, /integration-logs\/operations/);
});
