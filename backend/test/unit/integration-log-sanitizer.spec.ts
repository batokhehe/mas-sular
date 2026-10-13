import {
  DEFAULT_SANITIZE_OPTIONS,
  isPiiKey,
  isSensitiveKey,
  sanitizeErrorText,
  REDACTED,
  REDACTED_PII,
  TRUNCATED_MARKER,
  sanitizeBody,
  sanitizeEndpoint,
  sanitizePayload,
} from '../../src/infrastructure/integration-log/integration-log.sanitizer';

/**
 * The security boundary of P1 integration logging: whatever a provider sends or
 * answers, no credential and no unnecessary personal data may reach the database.
 */

const json = (v: unknown) => JSON.stringify(v);

describe('credentials never survive sanitization', () => {
  it('JNE authenticates in a form-urlencoded BODY — username and api_key are unrecoverable', () => {
    const raw = 'username=masular&api_key=SUPERSECRETKEY123&order_no=BMS-20260914-QSVGENC3&service_code=JTR%3C130&weight=2&origin_code=BDO10000&destination_zip=40112&receiver_name=John%20Doe&receiver_phone=6285861470308&receiver_addr=Jl.%20Veteran%20No.%2065';
    const out = sanitizeBody(raw, 'application/x-www-form-urlencoded') as Record<string, unknown>;

    expect(out.username).toBe(REDACTED);
    expect(out.api_key).toBe(REDACTED);
    expect(json(out)).not.toContain('SUPERSECRETKEY123');
    expect(json(out)).not.toContain('masular');
    // Operational fields survive — this is what a failure is diagnosed from.
    expect(out.order_no).toBe('BMS-20260914-QSVGENC3');
    expect(out.service_code).toBe('JTR<130');
    expect(out.weight).toBe('2');
    expect(out.origin_code).toBe('BDO10000');
    expect(out.destination_zip).toBe('40112');
    // Recipient PII does not.
    expect(out.receiver_name).toBe(REDACTED_PII);
    expect(out.receiver_phone).toBe(REDACTED_PII);
    expect(out.receiver_addr).toBe(REDACTED_PII);
    expect(json(out)).not.toContain('6285861470308');
    expect(json(out)).not.toContain('Veteran');
  });

  it('a form body is detected without a content-type header too', () => {
    const out = sanitizeBody('username=u&api_key=K&order_no=BMS-1') as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out.order_no).toBe('BMS-1');
  });

  it.each([
    ['authorization', { authorization: 'Basic U0ItTWlkLXNlcnZlci1LRVk6' }],
    ['server_key', { server_key: 'SB-Mid-server-ABC123' }],
    ['serverKey', { serverKey: 'SB-Mid-server-ABC123' }],
    ['webhook_secret', { webhook_secret: 'whsec_123' }],
    ['signature_key', { signature_key: 'a'.repeat(128) }],
    ['x-paxel-signature', { 'x-paxel-signature': 'deadbeef' }],
    ['cookie', { cookie: 'ms_session=true; admin=...' }],
    ['set-cookie', { 'set-cookie': 'admin_session=abc; HttpOnly' }],
    ['access_token', { access_token: 'at_123' }],
    ['refresh_token', { refresh_token: 'rt_123' }],
    ['password', { password: 'hunter2' }],
    ['api-key', { 'api-key': 'k_123' }],
    ['cvv', { cvv: '123' }],
    ['card_number', { card_number: '4111111111111111' }],
  ])('redacts %s at the top level', (key, payload) => {
    const out = sanitizePayload(payload) as Record<string, unknown>;
    expect(out[key]).toBe(REDACTED);
    expect(json(out)).not.toContain(Object.values(payload)[0] as string);
  });

  it('redacts NESTED secrets at any depth', () => {
    const out = sanitizePayload({
      transaction_details: { order_id: 'BMS-1', gross_amount: 50000 },
      credit_card: { token_id: 'tok_abc', authentication: true },
      meta: { auth: { authorization: 'Bearer abc.def.ghi', nested: { server_key: 'SB-Mid-server-XYZ' } } },
    }) as Record<string, Record<string, unknown>>;

    expect(json(out)).not.toContain('SB-Mid-server-XYZ');
    expect(json(out)).not.toContain('Bearer abc.def.ghi');
    expect(out.credit_card.token_id).toBe(REDACTED);
    // Operational values are untouched.
    expect(out.transaction_details.order_id).toBe('BMS-1');
    expect(out.transaction_details.gross_amount).toBe(50000);
  });

  it('scrubs JWT-shaped strings wherever they appear (reusing redactJwts)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s1gnatur3';
    // `status_message` is an operational field; `note`/`address` would be masked as
    // PII before the JWT scrub ever mattered (asserted separately below).
    const out = sanitizePayload({ status_message: `callback ${jwt} ok`, list: [jwt] }) as { status_message: string; list: string[] };
    expect(out.status_message).toContain('[REDACTED_JWT]');
    expect(out.status_message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out.list[0]).toBe('[REDACTED_JWT]');
  });

  it('keeps look-alike operational keys that merely contain a sensitive word', () => {
    const out = sanitizePayload({
      service_name: 'Paxel Same Day',
      city_name: 'Kota Bandung',
      postal_code: '40112',
      provider_status: 'ON_PROCESS',
      cnote_no: 'CNOTE12345',
      awb: 'PXL0000123',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      service_name: 'Paxel Same Day',
      city_name: 'Kota Bandung',
      postal_code: '40112',
      provider_status: 'ON_PROCESS',
      cnote_no: 'CNOTE12345',
      awb: 'PXL0000123',
    });
  });
});

describe('personal data', () => {
  it('masks recipient identity in a Paxel-shaped booking body, keeping the routing fields', () => {
    const out = sanitizeBody(
      json({
        service_type: 'SAMEDAY',
        weight: 1200,
        origin: { name: 'Mas Sular', phone: '628111', address: 'Outlet', postal_code: '40112', city: 'Kota Bandung' },
        destination: { name: 'Fani', phone: '085889050887', address: 'Grand Griya blok b 17', postal_code: '16921', city: 'Kab. Bogor' },
        customer_details: { email: 'buyer@example.com' },
      }),
      'application/json',
    ) as Record<string, Record<string, unknown>>;

    expect(out.destination.name).toBe(REDACTED_PII);
    expect(out.destination.phone).toBe(REDACTED_PII);
    expect(out.destination.address).toBe(REDACTED_PII);
    expect(out.customer_details.email).toBe(REDACTED_PII);
    expect(json(out)).not.toContain('085889050887');
    expect(json(out)).not.toContain('buyer@example.com');
    // Kept: everything needed to explain a routing/pricing failure.
    expect(out.destination.postal_code).toBe('16921');
    expect(out.destination.city).toBe('Kab. Bogor');
    expect(out.service_type).toBe('SAMEDAY');
    expect(out.weight).toBe(1200);
  });
});

describe('size limits', () => {
  it('truncates an oversized payload with an explicit marker instead of dropping it', () => {
    // Per-string capping runs first, so an oversized PAYLOAD needs many fields:
    // 50 items x the 2 000-char string cap is far past the 16 KB payload cap.
    const big = { items: Array.from({ length: 50 }, () => 'x'.repeat(2_000)) };
    const out = sanitizePayload(big) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(out.marker).toBe(TRUNCATED_MARKER);
    expect(out.limitBytes).toBe(DEFAULT_SANITIZE_OPTIONS.maxBytes);
    expect(String(out.preview).length).toBeLessThanOrEqual(DEFAULT_SANITIZE_OPTIONS.maxBytes + 64);
  });

  it('caps an individual long string and marks it', () => {
    const out = sanitizePayload({ status_message: 'y'.repeat(9_000) }, { ...DEFAULT_SANITIZE_OPTIONS, maxStringLength: 100 }) as {
      status_message: string;
    };
    expect(out.status_message.length).toBeLessThan(200);
    expect(out.status_message).toContain(TRUNCATED_MARKER);
  });

  it('a free-text delivery note is PII, not an operational field', () => {
    const out = sanitizePayload({ note: 'ring the bell, house behind the blue gate', notes: 'same' }) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED_PII);
    expect(out.notes).toBe(REDACTED_PII);
  });

  it('bounds arrays and depth', () => {
    const out = sanitizePayload({ items: Array.from({ length: 80 }, (_, i) => i) }, { ...DEFAULT_SANITIZE_OPTIONS, maxArrayItems: 5 }) as { items: unknown[] };
    expect(out.items).toHaveLength(6);
    expect(String(out.items[5])).toContain('75 more item(s)');

    const deep = sanitizePayload({ a: { b: { c: { d: { e: 'deep' } } } } }, { ...DEFAULT_SANITIZE_OPTIONS, maxDepth: 2 });
    expect(json(deep)).toContain(TRUNCATED_MARKER);
  });
});

describe('endpoints and odd bodies', () => {
  it('redacts capability tokens and credential query values in the endpoint', () => {
    expect(sanitizeEndpoint('https://api.example.com/api/v1/payments/upload/abc123/file')).toBe(
      'https://api.example.com/api/v1/payments/upload/[REDACTED]/file',
    );
    expect(sanitizeEndpoint('https://api.example.com/v2/status?api_key=secret&order_id=BMS-1')).toContain('api_key=[REDACTED]');
    expect(sanitizeEndpoint(null)).toBeNull();
  });

  it('non-JSON, empty and unparseable bodies are handled without throwing', () => {
    expect(sanitizeBody(null)).toBeNull();
    expect(sanitizeBody('')).toBeNull();
    expect(sanitizeBody('<html>bad gateway</html>', 'text/html')).toBe('<html>bad gateway</html>');
    expect(sanitizePayload(undefined)).toBeNull();
  });
});


describe('token-like keys are redacted in every casing and separator style (review finding 2)', () => {
  it.each([
    'token',
    'tokenId',
    'token_id',
    'cardTokenId',
    'card_token_id',
    'apiToken',
    'api_token',
    'bearerToken',
    'bearer_token',
    'xsrfToken',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'AUTH_TOKEN',
    'sessionToken',
  ])('%s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    const out = sanitizePayload({ [key]: 'SECRET-VALUE-123' }) as Record<string, unknown>;
    expect(out[key]).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('SECRET-VALUE-123');
  });

  it.each(['tokenized', 'tokenizer', 'tokens_count', 'brokenToken_note'])(
    'a word that merely CONTAINS "token" stays readable: %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(key === 'brokenToken_note'); // that one really is `…Token_…`
    },
  );

  it('operational keys are still neither sensitive nor PII', () => {
    for (const key of ['order_no', 'orderNumber', 'destination_zip', 'postalCode', 'serviceCode', 'cnote_no', 'awb', 'grossAmount']) {
      expect(isSensitiveKey(key)).toBe(false);
      expect(isPiiKey(key)).toBe(false);
    }
  });
});

describe('errorMessage sanitization (review finding 1)', () => {
  /** What the transports pass: the provider's RAW body, truncated to 300 characters. */
  const persisted = (raw: string) => sanitizeErrorText(raw, 512) ?? '';

  it('a JNE error echoing the form request keeps no credentials', () => {
    const out = persisted('provider 400: username=masular&api_key=SUPERSECRETKEY123&order_no=BMS-1&status=false&error=Data tidak ditemukan');
    expect(out).not.toContain('SUPERSECRETKEY123');
    expect(out).not.toContain('masular');
    expect(out).toContain(REDACTED);
    // The diagnostic half survives — that is why the column exists.
    expect(out).toContain('order_no=BMS-1');
    expect(out).toContain('Data tidak ditemukan');
  });

  it('a JSON error body with credentials is scrubbed key by key', () => {
    const out = persisted('midtrans 401: {"status_code":"401","status_message":"Access denied","server_key":"SB-Mid-server-ABC123","password":"hunter2"}');
    expect(out).not.toContain('SB-Mid-server-ABC123');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('Access denied');
    expect(out).toContain('"status_code":"401"');
  });

  it('Authorization / Bearer / JWT shapes are scrubbed wherever they appear', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.s1gnatur3';
    const out = persisted(`401 Unauthorized: Authorization: Bearer ${jwt} rejected`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(out).not.toContain(jwt);
    expect(out).toContain('401 Unauthorized');

    const basic = persisted('sent Authorization: Basic U0ItTWlkLXNlcnZlci1LRVk6 to the gateway');
    expect(basic).not.toContain('U0ItTWlkLXNlcnZlci1LRVk6');
  });

  it('recipient PII inside an error body is masked', () => {
    const out = persisted(
      'provider 422: {"receiver_name":"Budi Santoso","receiver_phone":"6285861470308","email":"buyer@example.com","receiver_addr":"Jl. Veteran No. 65","destination_zip":"40112"}',
    );
    for (const value of ['Budi Santoso', '6285861470308', 'buyer@example.com', 'Jl. Veteran']) expect(out).not.toContain(value);
    expect(out).toContain(REDACTED_PII);
    expect(out).toContain('40112'); // routing data kept
  });

  it('an ordinary provider message is left alone', () => {
    expect(persisted('provider 503: upstream temporarily unavailable')).toBe('provider 503: upstream temporarily unavailable');
    expect(sanitizeErrorText(null)).toBeNull();
    expect(sanitizeErrorText('')).toBeNull();
  });

  it('the result never exceeds the column width, marker included', () => {
    const out = persisted('x'.repeat(5_000));
    expect(out.length).toBeLessThanOrEqual(512);
    expect(out.endsWith(TRUNCATED_MARKER)).toBe(true);
  });
});
