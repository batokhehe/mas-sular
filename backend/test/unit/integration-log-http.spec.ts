import { Logger } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { executeShippingRequest } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { executeMidtransRequest } from '../../src/modules/payments/gateway/infrastructure/http/midtrans-http.client';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { PermanentGatewayError, TransientGatewayError } from '../../src/modules/payments/gateway/domain/payment-gateway-errors';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';

/**
 * One record per ACTUAL HTTP attempt, written by the transport. The behaviour the
 * transports already had - retry loop, error classes, thrown types - must not move,
 * so every case below asserts the thrown error AND the records side by side.
 */

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

function recorder() {
  const entries: IntegrationLogEntry[] = [];
  return { entries, record: (e: IntegrationLogEntry) => entries.push(e) };
}

const res = (status: number, text = '{}') => ({ status, text: async () => text, headers: { get: () => null } });

const shippingOpts = (http: unknown, rec: ReturnType<typeof recorder>, maxRetry = 2) => ({
  http: http as never,
  url: 'https://api.jne.example/tracing/api/pricedev',
  init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=u&api_key=SECRET&weight=2', timeoutMs: 1000 },
  maxRetry,
  logger: silentLogger,
  logBase: { provider: 'jne', origin: 'BDO10000', destination: 'BDO10060', service: 'RATE' },
  integration: { provider: IntegrationProvider.JNE, operation: 'RATE', recorder: rec, orderId: 'order-1' },
});

describe('executeShippingRequest records one row per attempt', () => {
  it('2xx → a single OK record carrying the sanitized request and response', async () => {
    const rec = recorder();
    const out = await executeShippingRequest(shippingOpts(async () => res(200, '{"price":[{"price":20000}]}'), rec));

    expect(out.status).toBe(200);
    expect(rec.entries).toHaveLength(1);
    const [entry] = rec.entries;
    expect(entry).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'RATE',
      direction: IntegrationDirection.OUTBOUND,
      attempt: 1,
      maxAttempts: 3,
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      orderId: 'order-1',
      method: 'POST',
    });
    expect(entry.operationId).toEqual(expect.any(String));
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    // The RAW body is handed over; the recorder sanitizes it (see the sanitizer spec).
    expect(entry.requestBody).toContain('api_key=SECRET');
    expect(entry.requestContentType).toBe('application/x-www-form-urlencoded');
    expect(entry.responseBody).toBe('{"price":[{"price":20000}]}');
  });

  it('4xx → PermanentError, one HTTP_ERROR record classified permanent_4xx', async () => {
    const rec = recorder();
    await expect(executeShippingRequest(shippingOpts(async () => res(400, 'bad request'), rec))).rejects.toBeInstanceOf(PermanentError);
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 400, applicationOutcome: IntegrationOutcome.HTTP_ERROR, errorClass: 'permanent_4xx', attempt: 1 });
  });

  it('429 → TransientError, NOT retried, one rate_limited record', async () => {
    const rec = recorder();
    const http = jest.fn(async () => res(429, 'Daily limit exceeded'));
    await expect(executeShippingRequest(shippingOpts(http, rec))).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(1); // retry semantics unchanged
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 429, errorClass: 'rate_limited', applicationOutcome: IntegrationOutcome.HTTP_ERROR });
  });

  it('500 then 200 → TWO records, same operationId, attempt 1 and 2', async () => {
    const rec = recorder();
    const http = jest.fn().mockResolvedValueOnce(res(500, 'boom')).mockResolvedValueOnce(res(200, '{"ok":true}'));
    const out = await executeShippingRequest(shippingOpts(http, rec));

    expect(out.status).toBe(200);
    expect(http).toHaveBeenCalledTimes(2);
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[0]).toMatchObject({ attempt: 1, httpStatus: 500, errorClass: 'provider_5xx', applicationOutcome: IntegrationOutcome.HTTP_ERROR });
    expect(rec.entries[1]).toMatchObject({ attempt: 2, httpStatus: 200, applicationOutcome: IntegrationOutcome.OK });
    expect(rec.entries[0].operationId).toBe(rec.entries[1].operationId);
    expect(out.operationId).toBe(rec.entries[0].operationId);
  });

  it('every 5xx exhausted → one record per attempt, all with the same operationId', async () => {
    const rec = recorder();
    await expect(executeShippingRequest(shippingOpts(async () => res(503, 'down'), rec))).rejects.toBeInstanceOf(TransientError);
    expect(rec.entries).toHaveLength(3);
    expect(new Set(rec.entries.map((e) => e.operationId)).size).toBe(1);
    expect(rec.entries.map((e) => e.attempt)).toEqual([1, 2, 3]);
  });

  it('network failure → NETWORK_ERROR records, one per attempt', async () => {
    const rec = recorder();
    const http = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(executeShippingRequest(shippingOpts(http, rec, 1))).rejects.toBeInstanceOf(TransientError);
    expect(rec.entries).toHaveLength(2);
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.NETWORK_ERROR, errorClass: 'network', httpStatus: null });
    expect(rec.entries[0].errorMessage).toContain('ECONNRESET');
  });

  it('timeout (AbortError) → TIMEOUT records', async () => {
    const rec = recorder();
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    await expect(
      executeShippingRequest(
        shippingOpts(
          async () => {
            throw abort;
          },
          rec,
          0,
        ),
      ),
    ).rejects.toBeInstanceOf(TransientError);
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.TIMEOUT, errorClass: 'timeout' });
  });

  it('WITHOUT an integration context nothing is recorded and behaviour is identical', async () => {
    const http = jest.fn(async () => res(200, 'ok'));
    const out = await executeShippingRequest({
      http: http as never,
      url: 'https://api.example/x',
      init: { method: 'GET', headers: {}, timeoutMs: 100 },
      maxRetry: 0,
      logger: silentLogger,
      logBase: { provider: 'paxel', origin: '-', destination: '-', service: 'TRACK' },
    });
    expect(out).toMatchObject({ status: 200, text: 'ok', operationId: '' });
  });

  it('a recorder that throws can never break the provider call', async () => {
    const exploding = {
      record: () => {
        throw new Error('database is down');
      },
    };
    const out = await executeShippingRequest({
      ...shippingOpts(async () => res(200, 'fine'), recorder()),
      integration: { provider: IntegrationProvider.JNE, operation: 'RATE', recorder: exploding },
    });
    expect(out.status).toBe(200);
  });
});

describe('executeMidtransRequest records one row per attempt', () => {
  const midtransOpts = (http: unknown, rec: ReturnType<typeof recorder>, maxRetry = 2) => ({
    http: http as never,
    url: 'https://api.sandbox.midtrans.com/v2/charge',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic U0ItTWlkLXNlcnZlci1LRVk6' },
      body: JSON.stringify({ payment_type: 'qris', transaction_details: { order_id: 'BMS-1', gross_amount: 50000 } }),
      timeoutMs: 1000,
    },
    maxRetry,
    logger: silentLogger,
    logBase: { provider: 'midtrans', op: 'charge' },
    integration: { provider: IntegrationProvider.MIDTRANS, operation: 'charge', recorder: rec, paymentId: 'pay-1' },
  });

  it('2xx JSON → one OK record', async () => {
    const rec = recorder();
    const body = '{"status_code":"201","transaction_id":"tx-1"}';
    await expect(executeMidtransRequest(midtransOpts(async () => ({ status: 200, text: async () => body }), rec))).resolves.toMatchObject({
      transaction_id: 'tx-1',
    });
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ operation: 'charge', httpStatus: 200, applicationOutcome: IntegrationOutcome.OK, paymentId: 'pay-1' });
    // Headers are NEVER handed to the recorder — the Authorization header included.
    expect(JSON.stringify(rec.entries[0])).not.toContain('U0ItTWlkLXNlcnZlci1LRVk6');
  });

  it('2xx with an unparseable body → PARSE_FAILED record, PermanentGatewayError unchanged', async () => {
    const rec = recorder();
    await expect(
      executeMidtransRequest(midtransOpts(async () => ({ status: 200, text: async () => '<html>maintenance</html>' }), rec)),
    ).rejects.toBeInstanceOf(PermanentGatewayError);
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 200, applicationOutcome: IntegrationOutcome.PARSE_FAILED, errorClass: 'parse_failed' });
    expect(rec.entries[0].responseBody).toContain('maintenance');
  });

  it('429 is retryable here (unchanged semantics) and each attempt is recorded', async () => {
    const rec = recorder();
    const http = jest.fn(async () => ({ status: 429, text: async () => 'slow down' }));
    await expect(executeMidtransRequest(midtransOpts(http, rec, 1))).rejects.toBeInstanceOf(TransientGatewayError);
    expect(http).toHaveBeenCalledTimes(2);
    expect(rec.entries.map((e) => e.errorClass)).toEqual(['rate_limited', 'rate_limited']);
  });

  it('4xx → permanent record, no retry', async () => {
    const rec = recorder();
    const http = jest.fn(async () => ({ status: 406, text: async () => 'duplicate order_id' }));
    await expect(executeMidtransRequest(midtransOpts(http, rec))).rejects.toBeInstanceOf(PermanentGatewayError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 406, errorClass: 'permanent', applicationOutcome: IntegrationOutcome.HTTP_ERROR });
  });

  it('500 then 200 → two records sharing one operationId', async () => {
    const rec = recorder();
    const http = jest
      .fn()
      .mockResolvedValueOnce({ status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({ status: 200, text: async () => '{"status_code":"200"}' });
    await executeMidtransRequest(midtransOpts(http, rec));
    expect(rec.entries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(new Set(rec.entries.map((e) => e.operationId)).size).toBe(1);
  });
});
