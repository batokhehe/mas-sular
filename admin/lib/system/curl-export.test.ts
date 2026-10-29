import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCurl, NOTE_HEADERS_NOT_STORED, NOTE_REAL_REQUEST, SENSITIVE_KEY, type CurlExport } from './curl-export.ts';

// Synthetic credentials: none of these may ever appear in a generated command or note.
const KEY = 'jne-key-DO-NOT-LEAK-123';
const USER = 'jne-user-DO-NOT-LEAK';
const SECRET_VALUES = [KEY, USER, 'mid-server-key-DO-NOT-LEAK', 'pin-9876'];

const jneRate = {
  provider: 'JNE' as const,
  direction: 'OUTBOUND' as const,
  method: 'POST',
  rawEndpoint: 'https://apiv2.jne.co.id:10102/tracing/api/pricedev',
  rawRequestBody: `username=${USER}&api_key=${KEY}&from=BDO10000&thru=BDO10104&weight=1`,
};

function ok(r: CurlExport) {
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r as Extract<CurlExport, { ok: true }>;
}

function noSecrets(r: CurlExport) {
  const text = JSON.stringify(r);
  for (const s of SECRET_VALUES) assert.ok(!text.includes(s), `leaked ${s}`);
}

/** What a POSIX shell makes of one generated argument (the --data-raw word), with the variables set. */
function shellValue(word: string, env: Record<string, string>): string {
  return execFileSync('sh', ['-c', `printf %s ${word}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }).toString('utf8');
}

const dataWord = (command: string) => command.split(' \\\n').find((l) => l.startsWith('  --data-raw '))!.slice('  --data-raw '.length);

test('JNE form body: credentials become variables, every business field is kept byte-for-byte', () => {
  const r = ok(buildCurl(jneRate, 'shell'));
  assert.equal(
    r.command,
    [
      "curl -X POST 'https://apiv2.jne.co.id:10102/tracing/api/pricedev'",
      "  -H 'Content-Type: application/x-www-form-urlencoded'",
      `  --data-raw 'username='"$JNE_USERNAME"'&api_key='"$JNE_API_KEY"'&from=BDO10000&thru=BDO10104&weight=1'`,
    ].join(' \\\n'),
  );
  assert.deepEqual(r.placeholders, ['JNE_API_KEY', 'JNE_USERNAME']);
  assert.ok(r.notes.includes(NOTE_REAL_REQUEST) && r.notes.includes(NOTE_HEADERS_NOT_STORED));
  assert.ok(r.notes.some((n) => n.includes('export JNE_API_KEY=...')));
  noSecrets(r);
  // The shell reproduces the stored body exactly once the operator sets the real values.
  assert.equal(shellValue(dataWord(r.command), { JNE_USERNAME: USER, JNE_API_KEY: KEY }), jneRate.rawRequestBody);
});

test('Postman flavour uses {{VARIABLE}} references inside one quoted word', () => {
  const r = ok(buildCurl(jneRate, 'postman'));
  assert.match(r.command, /--data-raw 'username=\{\{JNE_USERNAME\}\}&api_key=\{\{JNE_API_KEY\}\}&from=BDO10000&thru=BDO10104&weight=1'$/);
  assert.ok(r.notes.some((n) => n.includes('variabel environment Postman: JNE_API_KEY, JNE_USERNAME')));
  noSecrets(r);
});

test('JSON body: only credential values are cut out; the rest of the stored text is untouched', () => {
  const raw = '{\n  "transaction_details": {"order_id": "MS-1", "gross_amount": 25000},\n  "server_key": "mid-server-key-DO-NOT-LEAK",\n  "pin": 9876,\n  "note": "it\'s $HOME `x` \\"q\\" Ñ\\n"\n}';
  const log = { provider: 'MIDTRANS' as const, direction: 'OUTBOUND' as const, method: 'post', rawEndpoint: 'https://api.sandbox.midtrans.com/v2/charge', rawRequestBody: raw };
  const r = ok(buildCurl(log, 'shell'));
  assert.match(r.command, /^curl -X POST 'https:\/\/api\.sandbox\.midtrans\.com\/v2\/charge' \\\n  -H 'Content-Type: application\/json' \\\n  --data-raw /);
  assert.deepEqual(r.placeholders, ['MIDTRANS_PIN', 'MIDTRANS_SERVER_KEY']);
  noSecrets(r);
  // Quotes, $, backticks, escapes and non-ASCII survive the shell unchanged; the numeric
  // credential is a bare variable, the string one stays inside its JSON quotes.
  const expanded = shellValue(dataWord(r.command), { MIDTRANS_SERVER_KEY: 'mid-server-key-DO-NOT-LEAK', MIDTRANS_PIN: '9876' });
  assert.equal(expanded, raw);
});

test('a credential in the query string is replaced too; other parameters stay as stored', () => {
  const log = { ...jneRate, method: 'GET', rawEndpoint: `https://x.test/track?awb=AB%2012&api_key=${KEY}&lang=id`, rawRequestBody: null };
  const r = ok(buildCurl(log, 'shell'));
  assert.equal(r.command, `curl -X GET 'https://x.test/track?awb=AB%2012&api_key='"$JNE_API_KEY"'&lang=id'`);
  noSecrets(r);
});

test('an empty stored body is sent empty, without a guessed Content-Type', () => {
  const r = ok(buildCurl({ ...jneRate, rawRequestBody: '' }, 'shell'));
  assert.equal(r.command, ["curl -X POST 'https://apiv2.jne.co.id:10102/tracing/api/pricedev'", "  --data-raw ''"].join(' \\\n'));
  assert.deepEqual(r.placeholders, []);
});

test('a body-less GET with no stored body is fine; a POST without its body is refused', () => {
  assert.equal(ok(buildCurl({ ...jneRate, method: 'GET', rawRequestBody: null }, 'shell')).command, "curl -X GET 'https://apiv2.jne.co.id:10102/tracing/api/pricedev'");
  // A Paxel RATE record: the body was never stored - say so, never reconstruct it.
  const rate = buildCurl({ provider: 'PAXEL', direction: 'OUTBOUND', method: 'POST', rawEndpoint: 'https://commerce-api.paxel.co/v1/rates/city', rawRequestBody: null }, 'shell');
  assert.equal(rate.ok, false);
  assert.match((rate as { reason: string }).reason, /Body request POST tidak tersimpan/);
});

test('what is missing is named instead of producing a misleading command', () => {
  const reason = (r: CurlExport) => (r.ok ? assert.fail('expected a refusal') : r.reason);
  assert.match(reason(buildCurl({ ...jneRate, direction: 'INBOUND' }, 'shell')), /hanya untuk request keluar/);
  assert.match(reason(buildCurl({ ...jneRate, rawEndpoint: null }, 'shell')), /URL persis tidak tersimpan/);
  assert.match(reason(buildCurl({ ...jneRate, method: null }, 'shell')), /Metode HTTP tidak tersimpan/);
  assert.match(reason(buildCurl({ ...jneRate, rawEndpoint: 'ftp://x.test/a' }, 'shell')), /bukan http/);
  assert.match(reason(buildCurl({ ...jneRate, rawEndpoint: 'https://u:p@x.test/a' }, 'shell')), /memuat kredensial/);
  assert.match(reason(buildCurl({ ...jneRate, rawEndpoint: 'not a url' }, 'shell')), /tidak valid/);
});

test('unsupported or ambiguous bodies are refused, never sent with a guessed type', () => {
  const reason = (body: string) => {
    const r = buildCurl({ ...jneRate, rawRequestBody: body }, 'shell');
    return r.ok ? assert.fail(`expected a refusal for ${body}`) : r.reason;
  };
  assert.match(reason('<xml>api_key</xml>'), /Format body tidak dikenali/);
  assert.match(reason('plain text with spaces'), /Format body tidak dikenali/);
  assert.match(reason('"a json string"'), /Format body tidak dikenali/);
  assert.match(reason('a=%E0%A4%A&b=1'), /Format body tidak dikenali/);
  // A credential holding an object cannot be cut out exactly: refused rather than leaked.
  assert.match(reason(`{"credentials": {"api_key": "${KEY}"}}`), /berisi objek/);
  noSecrets(buildCurl({ ...jneRate, rawRequestBody: `{"credentials": {"api_key": "${KEY}"}}` }, 'shell'));
});

test('the credential key list is the integration-log sanitizer\'s own', () => {
  const sanitizer = readFileSync(join(process.cwd(), '../backend/src/infrastructure/integration-log/integration-log.sanitizer.ts'), 'utf8');
  const backend = sanitizer.match(/const SENSITIVE_KEY =\s*(\/.*\/i);/)?.[1];
  assert.equal(backend, SENSITIVE_KEY.toString());
});

test('the drawer offers the copy under the request body and shows the reason when it cannot', () => {
  const page = readFileSync(join(process.cwd(), 'app/system/integration-logs/page.tsx'), 'utf8');
  assert.match(page, /<BodyPayload title="Body request" raw=\{log\.rawRequestBody\} sanitized=\{log\.sanitizedRequest\} \/>\n\s*<CopyCurl log=\{log\} \/>/);
  assert.match(page, /if \(!shell\.ok\) return <p className="mt-2 text-xs text-gray-400">cURL: \{shell\.reason\}<\/p>;/);
  // The clipboard only ever receives the generated command, never a raw body.
  assert.deepEqual(page.match(/writeText\([^)]*\)/g), ['writeText(text)']);
});
