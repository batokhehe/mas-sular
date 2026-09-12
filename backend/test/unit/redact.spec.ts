import { redactSensitiveParams, redactSensitivePath } from '../../src/common/logging/redact';

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
