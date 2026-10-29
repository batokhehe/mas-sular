/**
 * raw-credentials.ts: what the RAW integration-log columns keep. Only credential
 * values are replaced - in place, so structure, formatting and every business value
 * survive - and the marker says what was there (length, and for long values a short
 * fingerprint) without revealing it.
 */
import { createHash } from 'crypto';
import { credentialMarker, FINGERPRINT_MIN, isRedactionMarker, redactRawBody, redactRawUrl } from '../../src/infrastructure/integration-log/raw-credentials';

// Synthetic only.
const KEY = 'jne-live-key-DO-NOT-LEAK-0123456789';
const SHORT = 'store';
const sha8 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex').slice(0, 8);
const LONG_MARK = `[REDACTED:len${KEY.length}:sha256-${sha8(KEY)}]`;

describe('the marker', () => {
  it('gives length always, a fingerprint only from FINGERPRINT_MIN characters', () => {
    expect(credentialMarker(SHORT)).toBe('[REDACTED:len5]');
    expect(credentialMarker('x'.repeat(FINGERPRINT_MIN - 1))).toBe(`[REDACTED:len${FINGERPRINT_MIN - 1}]`);
    expect(credentialMarker(KEY)).toBe(LONG_MARK);
    // The operator check: the same value always gives the same fingerprint.
    expect(credentialMarker(KEY)).toBe(credentialMarker(KEY));
    expect(credentialMarker(`${KEY}x`)).not.toBe(LONG_MARK);
  });

  it('is recognised and never re-marked', () => {
    for (const m of [LONG_MARK, '[REDACTED:len5]', '[REDACTED]', '[REDACTED:object]']) {
      expect(isRedactionMarker(m)).toBe(true);
      expect(credentialMarker(m)).toBe(m);
    }
    expect(isRedactionMarker('[REDACTED] x')).toBe(false);
  });
});

describe('form-urlencoded bodies (JNE)', () => {
  const body = `username=${SHORT}&api_key=${KEY}&from=BDO10000&thru=BDO10104&weight=1&RECEIVER_NAME=Budi+Santoso&RECEIVER_ADDR1=Jl.%20Veteran%20No.%207&password=p%26w`;

  it('replaces only credential values; every other pair stays byte-for-byte', () => {
    expect(redactRawBody(body)).toBe(
      `username=[REDACTED:len5]&api_key=${LONG_MARK}&from=BDO10000&thru=BDO10104&weight=1&RECEIVER_NAME=Budi+Santoso&RECEIVER_ADDR1=Jl.%20Veteran%20No.%207&password=[REDACTED:len3]`,
    );
  });

  it('measures the DECODED value and stays a clean pair list', () => {
    const out = redactRawBody(body)!;
    expect(out).toContain('password=[REDACTED:len3]'); // "p&w", not "p%26w"
    expect(out).toMatch(/^[^&=\s]+=[^&\s]*(&[^&=\s]+=[^&\s]*)*$/);
    expect(new URLSearchParams(out).get('thru')).toBe('BDO10104');
    expect(out).not.toContain(KEY);
  });
});

describe('JSON bodies', () => {
  it('cuts credential values in place: whitespace, key order, escapes and exact numbers survive', () => {
    const raw = `{\n  "order_id": "MS-1",\n  "gross_amount": 25000.50,\n  "id": 12345678901234567890,\n  "server_key": "${KEY}",\n  "pin": 9876,\n  "note": "Jl. \\"Haji\\" \\u00d1",\n  "verified": true\n}`;
    const out = redactRawBody(raw)!;
    expect(out).toBe(
      `{\n  "order_id": "MS-1",\n  "gross_amount": 25000.50,\n  "id": 12345678901234567890,\n  "server_key": "${LONG_MARK}",\n  "pin": "[REDACTED:len4]",\n  "note": "Jl. \\"Haji\\" \\u00d1",\n  "verified": true\n}`,
    );
    expect(() => JSON.parse(out)).not.toThrow();
    expect(Object.keys(JSON.parse(out))).toEqual(Object.keys(JSON.parse(raw)));
  });

  it('nested and camelCase credentials, and a credential holding an object or array, are replaced whole', () => {
    const raw = JSON.stringify({
      transaction_details: { order_id: 'MS-2', gross_amount: 101000 },
      customer: { email: 'buyer@example.com', accessToken: KEY },
      credentials: { api_key: KEY, user: 'x' },
      items: [{ sku: 'BKS-1', price: 18000, cardToken: 'tok_123' }],
      apiKeys: [KEY, KEY],
      flags: { password: null, otp: false },
    });
    const out = JSON.parse(redactRawBody(raw)!);
    expect(out).toEqual({
      transaction_details: { order_id: 'MS-2', gross_amount: 101000 },
      customer: { email: 'buyer@example.com', accessToken: LONG_MARK },
      credentials: '[REDACTED:object]',
      items: [{ sku: 'BKS-1', price: 18000, cardToken: '[REDACTED:len7]' }],
      apiKeys: '[REDACTED:array]',
      // No secret in a null or a boolean: they keep their meaning.
      flags: { password: null, otp: false },
    });
    expect(redactRawBody(raw)).not.toContain(KEY);
  });

  it('a credential SHAPE inside an ordinary string is scrubbed; business prose is not mistaken for a pair', () => {
    const raw = JSON.stringify({ debug: `Authorization: Bearer ${KEY}`, header_note: 'Set-Cookie: sid=abc123; Path=/', cookie_note: 'anything', note: 'session: pagi, token: none' });
    const out = JSON.parse(redactRawBody(raw)!);
    expect(out.debug).toBe(`Authorization: Bearer ${LONG_MARK}`);
    expect(out.header_note).toBe('Set-Cookie: [REDACTED:len18]');
    // A key that IS a credential name masks its whole value, whatever it holds.
    expect(out.cookie_note).toBe('[REDACTED:len8]');
    expect(out.note).toBe('session: pagi, token: none');
  });

  it('a top-level array and an empty object are handled; a sensitive key that only appears as a VALUE is left alone', () => {
    expect(redactRawBody(`[{"api_key":"${KEY}"},{"ok":1}]`)).toBe(`[{"api_key":"${LONG_MARK}"},{"ok":1}]`);
    expect(redactRawBody('{}')).toBe('{}');
    expect(redactRawBody('{"field":"api_key","value":"x"}')).toBe('{"field":"api_key","value":"x"}');
  });
});

describe('free-text bodies (HTML error pages, plain text)', () => {
  it('Authorization, Cookie and credential pairs are scrubbed; the rest of the text is kept', () => {
    const text = `<html>401 for request\nAuthorization: Basic ${Buffer.from('store:pass').toString('base64')}\nCookie: session=s3cr3t-value\napi_key: ${KEY} rejected for order MS-9</html>`;
    const out = redactRawBody(text)!;
    expect(out).toContain('<html>401 for request');
    expect(out).toContain('Authorization: Basic [REDACTED:len16]');
    expect(out).toContain(`Cookie: [REDACTED:len20:sha256-${sha8('session=s3cr3t-value')}]`);
    expect(out).toContain(`api_key: ${LONG_MARK} rejected for order MS-9</html>`);
    for (const secret of ['c3RvcmU6cGFzcw==', 's3cr3t-value', KEY]) expect(out).not.toContain(secret);
  });

  it('a text with no credential shape is returned unchanged; empty and missing bodies stay as they were', () => {
    expect(redactRawBody('Bad Gateway')).toBe('Bad Gateway');
    expect(redactRawBody('')).toBe('');
    expect(redactRawBody(null)).toBeNull();
    expect(redactRawBody(undefined)).toBeNull();
  });
});

describe('URLs', () => {
  it('credential query values, userinfo and capability path tokens are replaced; the rest is kept', () => {
    expect(redactRawUrl(`https://api.test/v2/charge?order=MS-1&api_key=${KEY}&lang=id#frag`)).toBe(`https://api.test/v2/charge?order=MS-1&api_key=${LONG_MARK}&lang=id#frag`);
    expect(redactRawUrl(`https://${SHORT}:pw@api.test/a?b=1`)).toBe('https://[REDACTED:len8]@api.test/a?b=1');
    expect(redactRawUrl('https://commerce-api.paxel.co/v1/rates/city')).toBe('https://commerce-api.paxel.co/v1/rates/city');
    expect(redactRawUrl('https://x.test/a?flag&b=1')).toBe('https://x.test/a?flag&b=1');
    expect(redactRawUrl(null)).toBeNull();
  });
});

describe('idempotent: masking an already-redacted value changes nothing', () => {
  it.each([
    [`username=${SHORT}&api_key=${KEY}&thru=BDO10104`],
    [JSON.stringify({ signature_key: KEY, nested: { token: 'abc', price: 1 }, debug: `Bearer ${KEY}` })],
    [`Authorization: Bearer ${KEY}\nCookie: a=b`],
  ])('%s', (raw) => {
    const once = redactRawBody(raw)!;
    expect(redactRawBody(once)).toBe(once);
  });

  it('URLs too', () => {
    const once = redactRawUrl(`https://u:p@x.test/a?token=${KEY}`)!;
    expect(redactRawUrl(once)).toBe(once);
  });
});

describe('pre-merge review findings', () => {
  // Bypasses found by probing: credentials in text the strict JSON reader cannot parse.
  it.each([
    ['truncated JSON', `{"api_key": "${KEY}", "order": "MS-1"`, `{"api_key": "${LONG_MARK}", "order": "MS-1"`],
    ['NDJSON', `{"api_key":"${KEY}"}\n{"ok":1}`, `{"api_key":"${LONG_MARK}"}\n{"ok":1}`],
    ['single-quoted pseudo-JSON', `{'api_key': '${KEY}'}`, `{'api_key': '${LONG_MARK}'}`],
    ['a form-like body with a trailing newline and a comma in a value', `api_key=${KEY}&password=ab,cd\n`, `api_key=${LONG_MARK}&password=[REDACTED:len5]\n`],
  ])('%s is redacted', (_what, raw, expected) => {
    expect(redactRawBody(raw)).toBe(expected);
  });

  it('inside a JSON string: header-style API keys, credential URL parameters and JWTs are scrubbed', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh';
    const out = JSON.parse(redactRawBody(JSON.stringify({ debug: `X-Paxel-API-Key: ${KEY}`, redirect_url: `https://x.test/pay?order=MS-1&token=${KEY}`, note: jwt }))!);
    expect(out).toEqual({ debug: `X-Paxel-API-Key: ${LONG_MARK}`, redirect_url: `https://x.test/pay?order=MS-1&token=${LONG_MARK}`, note: credentialMarker(jwt) });
  });

  it('a credential in a URL fragment is replaced', () => {
    expect(redactRawUrl(`https://x.test/cb#state=ok&access_token=${KEY}`)).toBe(`https://x.test/cb#state=ok&access_token=${LONG_MARK}`);
  });

  // False positives found against the key names in real stored payloads.
  it('Paxel/JNE proof-of-delivery signature URLs are business data and are kept', () => {
    const raw = JSON.stringify({ airwaybill_code: 'PXL1', signature: 'https://cdn.paxel.co/sig/1.png', pdo_signature: '', photo: 'https://cdn.paxel.co/p.png' });
    expect(redactRawBody(raw)).toBe(raw);
    // ...minus any credential the link itself carries.
    expect(JSON.parse(redactRawBody(JSON.stringify({ signature: `https://cdn.test/s.png?X-Amz-Signature=${KEY}&w=1` }))!).signature).toBe(`https://cdn.test/s.png?X-Amz-Signature=${LONG_MARK}&w=1`);
    // A signature that is NOT a URL (Midtrans signature_key) is still a credential.
    expect(redactRawBody(JSON.stringify({ signature_key: KEY }))).toBe(JSON.stringify({ signature_key: LONG_MARK }));
  });

  it('an empty credential value hides nothing and is left as it is', () => {
    expect(redactRawBody('{"password":"","api_key":""}')).toBe('{"password":"","api_key":""}');
  });

  it('usernames, passwords, PINs, Basic credentials and URL userinfo never get a fingerprint, however long', () => {
    const long = 'MASSULARBANDUNGSTORE01';
    expect(redactRawBody(`username=${long}&password=${long}`)).toBe('username=[REDACTED:len22]&password=[REDACTED:len22]');
    expect(redactRawBody(JSON.stringify({ pin: long, card_number: long }))).toBe(JSON.stringify({ pin: '[REDACTED:len22]', card_number: '[REDACTED:len22]' }));
    expect(redactRawBody(`Authorization: Basic ${Buffer.from(`${long}:${long}`).toString('base64')}`)).toMatch(/^Authorization: Basic \[REDACTED:len60\]$/);
    expect(redactRawUrl(`https://${long}:${long}@x.test/a`)).toBe('https://[REDACTED:len45]@x.test/a');
    // Machine-generated keys still do.
    expect(redactRawBody(`api_key=${KEY}`)).toBe(`api_key=${LONG_MARK}`);
  });
});
