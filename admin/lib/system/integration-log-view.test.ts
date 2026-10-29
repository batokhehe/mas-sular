import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PLACEHOLDER_NOTE,
  bodyView,
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

  assert.equal(formatAttempt({ attempt: 2, maxAttempts: 3 }), '2 dari 3');
  assert.equal(formatAttempt({ attempt: 1, maxAttempts: null }), '1');
  // The application-outcome record has no attempt of its own.
  assert.equal(formatAttempt({ attempt: null, maxAttempts: null }), 'hasil');

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

// The shape a Paxel RATE row stores: no raw body, a city/district summary only.
const RATE_REQUEST_SUMMARY = {
  service_type: 'SAMEDAY',
  weight: 1500,
  dimension: '30x35x20',
  origin: { province: 'Jawa Barat', city: 'Kota Bandung', district: 'Coblong' },
  destination: { province: 'Jawa Barat', city: 'Kabupaten Bandung', district: 'Bojongsoang' },
};
const RATE_RESPONSE_SUMMARY = { code: 400, message: 'Service type is not available', errors: { service_type: ['invalid'] } };

test('an exact body wins over the sanitized summary and is shown byte-for-byte', () => {
  const raw = '{"username":"store","api_key":"secret"}';
  assert.deepEqual(bodyView('Body request', raw, { username: '[REDACTED]', api_key: '[REDACTED]' }), {
    kind: 'exact',
    label: 'Body request (exact)',
    empty: false,
    text: raw,
  });
  // A real empty body is still an exact capture, not a reason to fall back.
  assert.deepEqual(bodyView('Body respons', '', RATE_RESPONSE_SUMMARY), { kind: 'exact', label: 'Body respons: (empty body)', empty: true, text: '' });
});

test('without an exact body the sanitized summary is shown, pretty-printed and labelled as a summary', () => {
  const request = bodyView('Body request', null, RATE_REQUEST_SUMMARY);
  assert.equal(request.kind, 'summary');
  assert.equal(request.label, 'Body request (ringkasan tersanitasi — bukan payload asli)');
  assert.equal((request as { text: string }).text, JSON.stringify(RATE_REQUEST_SUMMARY, null, 2));
  // Every summary says what its placeholders are and that the payload itself is gone.
  assert.equal((request as { note: string }).note, PLACEHOLDER_NOTE);
  assert.match(PLACEHOLDER_NOTE, /\[NUMBER\] dan \[TEXT\] = nilai yang disembunyikan/);
  assert.match(PLACEHOLDER_NOTE, /tidak dapat dipulihkan/);

  const response = bodyView('Body respons', undefined, RATE_RESPONSE_SUMMARY);
  assert.equal(response.label, 'Body respons (ringkasan tersanitasi — bukan payload asli)');
  assert.deepEqual(JSON.parse((response as { text: string }).text), RATE_RESPONSE_SUMMARY);
  assert.match((response as { text: string }).text, /\n {2}"code": 400,/);

  // The stored value is only formatted - nothing is added, re-redacted or dropped.
  assert.equal((bodyView('Body respons', null, { nonJson: true, length: 87 }) as { text: string }).text, '{\n  "nonJson": true,\n  "length": 87\n}');
  assert.equal((bodyView('Body respons', null, {}) as { text: string }).text, '{}');
  assert.equal((bodyView('Body respons', null, ['a']) as { text: string }).text, '[\n  "a"\n]');
  // The sanitizer stores a non-JSON body as plain text: shown as text, not re-quoted.
  assert.equal((bodyView('Body respons', null, 'Bad Gateway') as { text: string }).text, 'Bad Gateway');
});

test('only when neither the exact body nor a summary exists is the body reported as not recorded', () => {
  for (const raw of [null, undefined]) {
    for (const sanitized of [null, undefined, '']) {
      assert.deepEqual(bodyView('Body request', raw, sanitized), { kind: 'none', label: 'Body request: tidak tercatat untuk data ini' });
    }
  }
});

test('the URL shown is the exact one when captured', () => {
  assert.equal(exactEndpoint({ rawEndpoint: 'https://apiv2.jne.co.id:10202/pickupcashless?x=secret', endpoint: 'https://apiv2.jne.co.id:10202/pickupcashless?x=[REDACTED]' }), 'https://apiv2.jne.co.id:10202/pickupcashless?x=secret');
  assert.equal(exactEndpoint({ rawEndpoint: null, endpoint: 'https://jne.test/x' }), 'https://jne.test/x');
});

test('the page is gated by IntegrationLog.read and registered in the System menu', () => {
  assert.deepEqual(ROUTE_PERMISSIONS.integrationLogs, ['IntegrationLog.read']);
  const page = read('app/system/integration-logs/page.tsx');
  assert.match(page, /<AdminShell requiredPermissions=\{ROUTE_PERMISSIONS\.integrationLogs\}>/);
  assert.match(read('lib/navigation.ts'), /\{ href: '\/system\/integration-logs', label: 'Log Integrasi', icon: 'integrations', permissions: ROUTE_PERMISSIONS\.integrationLogs \}/);
  assert.match(read('components/layout/sidebar.tsx'), /integrations: Plug,/);
});

test('the list shows the documented columns and the drawer the documented context', () => {
  const page = read('app/system/integration-logs/page.tsx');
  for (const column of ['Waktu', 'Penyedia', 'Operasi', 'Arah', 'HTTP', 'Durasi', 'Pesanan', 'Hasil']) {
    assert.match(page, new RegExp(`<th className="py-3 font-medium">${column}</th>`), `column ${column}`);
  }
  for (const field of ['Operation ID', 'Request ID', 'Correlation ID', 'ID Pesanan', 'ID Pembayaran', 'ID Pengiriman', 'Percobaan', 'Durasi']) {
    assert.match(page, new RegExp(`<Field label="${field}"`), `context field ${field}`);
  }
  // The drawer shows the exchange EXACTLY as captured, and falls back to the stored
  // sanitized summary of the SAME side only when there is no exact capture.
  assert.match(page, /<BodyPayload title="Body request" raw=\{log\.rawRequestBody\} sanitized=\{log\.sanitizedRequest\} \/>/);
  assert.match(page, /<BodyPayload title="Body respons" raw=\{log\.rawResponseBody\} sanitized=\{log\.sanitizedResponse\} \/>/);
  assert.match(page, /const body = bodyView\(title, raw, sanitized\);/);
  assert.match(page, /<p className="px-3 pb-2 text-xs text-amber-700">\{body\.note\}<\/p>/);
  assert.match(page, /<Field label="URL" value=\{<span className="break-all font-mono text-xs">\{exactEndpoint\(log\) \?\? '—'\}<\/span>\} \/>/);
  // Formatting and labels live in the tested helper; the page neither reformats nor
  // re-labels a body, and no other sanitized/raw pairing exists.
  assert.doesNotMatch(page, /prettyPayload|JSON\.stringify|exactBody\(/);
  assert.equal(page.match(/sanitized=\{log\.sanitized(Request|Response)\}/g)?.length, 2);
  // Rendered verbatim: whitespace preserved, the text itself untouched.
  assert.match(page, /whitespace-pre-wrap break-all rounded-b-lg bg-gray-50 p-3 font-mono text-xs text-gray-700">\{body\.text\}<\/pre>/);
  // The description no longer claims every record holds the exact payload.
  assert.match(page, /Bila tersimpan, tampilan detail menunjukkan request dan respons persis/);
  assert.match(page, /hanya menyimpan ringkasan tersanitasi, bukan payload asli/);
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
