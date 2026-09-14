import { PINO_HTTP_REDACT, redactJwts, redactSensitiveParams, redactSensitivePath, redactSensitiveQuery } from '../../src/common/logging/redact';

describe('redactSensitiveParams (pino-http logs req.params)', () => {
  const raw = 'f'.repeat(64);

  it('P2 #14: masks the token inside the versioned path params (the observed pino shape)', () => {
    expect(redactSensitiveParams({ path: ['v1', 'invoices', raw] })).toEqual({ path: ['v1', 'invoices', '[REDACTED]'] });
    expect(JSON.stringify(redactSensitiveParams({ path: ['v1', 'invoices', raw] }))).not.toContain(raw);
  });

  it('also the payment-upload token, as an array or a joined string', () => {
    expect(redactSensitiveParams({ path: ['v1', 'payments', 'upload', raw] })).toEqual({ path: ['v1', 'payments', 'upload', '[REDACTED]'] });
    expect(redactSensitiveParams({ path: `v1/payments/upload/${raw}` })).toEqual({ path: 'v1/payments/upload/[REDACTED]' });
  });

  it('masks any param named like a token, keeps everything else', () => {
    expect(redactSensitiveParams({ token: raw, id: 'order-1', path: ['v1', 'admin', 'orders', 'order-1'] })).toEqual({
      token: '[REDACTED]',
      id: 'order-1',
      path: ['v1', 'admin', 'orders', 'order-1'],
    });
    expect(redactSensitiveParams(undefined)).toBeUndefined();
    expect(redactSensitiveParams(null)).toBeNull();
  });
});

describe('redactSensitivePath', () => {
  it('redacts the upload token segment', () => {
    expect(redactSensitivePath('/payments/upload/abc123deadbeef')).toBe('/payments/upload/[REDACTED]');
  });

  it('redacts under the global api/version prefix', () => {
    expect(redactSensitivePath('/api/v1/payments/upload/abc123')).toBe('/api/v1/payments/upload/[REDACTED]');
  });

  it('preserves a trailing query string while redacting the token', () => {
    expect(redactSensitivePath('/payments/upload/secrettoken?foo=bar')).toBe('/payments/upload/[REDACTED]?foo=bar');
  });

  it('P2 #14: redacts the customer invoice token segment (with prefix and query kept)', () => {
    const raw = 'c'.repeat(64);
    expect(redactSensitivePath(`/api/v1/invoices/${raw}`)).toBe('/api/v1/invoices/[REDACTED]');
    expect(redactSensitivePath(`/api/v1/invoices/${raw}?x=1`)).toBe('/api/v1/invoices/[REDACTED]?x=1');
    expect(redactSensitivePath(`/api/v1/invoices/${raw}`)).not.toContain(raw);
  });

  it('leaves unrelated paths unchanged', () => {
    expect(redactSensitivePath('/api/v1/orders/checkout')).toBe('/api/v1/orders/checkout');
    expect(redactSensitivePath('/payments/pay-1/manual-receipt')).toBe('/payments/pay-1/manual-receipt');
  });

  it('passes through undefined', () => {
    expect(redactSensitivePath(undefined)).toBeUndefined();
  });
});

describe('H2: credentials never survive into logged URLs, queries or headers', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG0tMSIsInNpZCI6InMiLCJ0eXAiOiJhZG1pbl9hY2Nlc3MifQ.c2lnbmF0dXJlLXZhbHVl';

  it('strips the VALUE of credential-like query parameters but keeps the key', () => {
    expect(redactSensitivePath(`/api/v1/admin/notifications/stream?token=${JWT}`)).toBe('/api/v1/admin/notifications/stream?token=[REDACTED]');
    expect(redactSensitivePath(`/x?cursor=abc&access_token=${JWT}&limit=5`)).toBe('/x?cursor=abc&access_token=[REDACTED]&limit=5');
    expect(redactSensitivePath('/x?refresh_token=abc#frag')).toBe('/x?refresh_token=[REDACTED]#frag');
    expect(redactSensitivePath('/x?cursor=abc')).toBe('/x?cursor=abc');
  });

  it('scrubs a JWT anywhere, whatever the parameter is called', () => {
    expect(redactSensitivePath(`/x?q=${JWT}`)).not.toContain(JWT);
    expect(redactSensitivePath(`/x/${JWT}/y`)).not.toContain(JWT);
    expect(redactJwts(`Bearer ${JWT} and more`)).toBe('Bearer [REDACTED_JWT] and more');
  });

  it('redactSensitiveQuery masks credential keys and JWT-shaped values', () => {
    expect(redactSensitiveQuery({ token: JWT, jwt: 'x', sid: 'y', cursor: 'c', q: JWT })).toEqual({
      token: '[REDACTED]', jwt: '[REDACTED]', sid: '[REDACTED]', cursor: 'c', q: '[REDACTED_JWT]',
    });
  });

  it('pino-http redacts authorization, cookie, CSRF, query and the Set-Cookie response header', () => {
    for (const path of ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.query', 'req.url', 'res.headers["set-cookie"]']) {
      expect(PINO_HTTP_REDACT.paths).toContain(path);
    }
    expect(PINO_HTTP_REDACT.censor([`ms_admin_access=${JWT}; HttpOnly`], ['res', 'headers', 'set-cookie'])).toBe('[Redacted]');
    expect(PINO_HTTP_REDACT.censor({ token: JWT }, ['req', 'query'])).toEqual({ token: '[REDACTED]' });
    expect(String(PINO_HTTP_REDACT.censor(`/s?token=${JWT}`, ['req', 'url']))).not.toContain(JWT);
  });
});
