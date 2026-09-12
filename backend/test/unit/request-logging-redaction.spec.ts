import { EventEmitter } from 'events';
import { RequestLoggingMiddleware } from '../../src/infrastructure/logging/request-logging.middleware';

/**
 * P2 #14 regression: the SystemLog `http/request.finished` row persisted the raw
 * route params, and under URI versioning those contain the whole path - including
 * the invoice (and payment-upload) capability token. Found in the running stack.
 */
describe('RequestLoggingMiddleware never persists a capability token', () => {
  const raw = '9'.repeat(64);

  function run(url: string, params: Record<string, unknown>) {
    const write = jest.fn();
    const mw = new RequestLoggingMiddleware({ write } as never, { enabled: true } as never);
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: jest.fn() });
    const req = { originalUrl: url, url, method: 'GET', headers: {}, query: {}, params, socket: {} };
    mw.use(req as never, res as never, () => undefined);
    res.emit('finish');
    return write.mock.calls[0][0];
  }

  it.each([
    ['invoice', `/api/v1/invoices/${raw}`, { path: ['v1', 'invoices', raw] }],
    ['payment upload', `/api/v1/payments/upload/${raw}`, { path: ['v1', 'payments', 'upload', raw] }],
  ])('%s link: path, message and metadata.params are all redacted', (_label, url, params) => {
    const row = run(url, params);
    expect(JSON.stringify(row)).not.toContain(raw);
    expect(row.path).toMatch(/\[REDACTED\]$/);
    expect(JSON.stringify(row.metadata.params)).toContain('[REDACTED]');
  });

  it('ordinary params are still recorded', () => {
    const row = run('/api/v1/admin/orders/order-1', { id: 'order-1' });
    expect(row.metadata.params).toEqual({ id: 'order-1' });
    expect(row.orderId).toBe('order-1');
  });
});
