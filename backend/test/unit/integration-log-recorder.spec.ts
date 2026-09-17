import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { IntegrationLogService } from '../../src/infrastructure/integration-log/integration-log.service';
import { loadIntegrationLogConfig } from '../../src/infrastructure/integration-log/integration-log.config';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';
import { REDACTED, REDACTED_PII } from '../../src/infrastructure/integration-log/integration-log.sanitizer';

/** The recorder: sanitizes, truncates to the column widths, and NEVER throws. */

const ENTRY: IntegrationLogEntry = {
  provider: IntegrationProvider.JNE,
  operation: 'GENERATE_CNOTE',
  direction: IntegrationDirection.OUTBOUND,
  operationId: 'op-1',
  attempt: 1,
  maxAttempts: 3,
  method: 'POST',
  endpoint: 'https://jne.test/tracing/api/generatecnote',
  httpStatus: 200,
  durationMs: 3195,
  applicationOutcome: IntegrationOutcome.PARSE_FAILED,
  errorClass: 'parse_failed',
  errorMessage: 'JNE did not return a cnote (unknown)',
  requestBody: 'username=store&api_key=SECRET&order_no=BMS-1&receiver_name=Budi&destination_zip=40112',
  requestContentType: 'application/x-www-form-urlencoded',
  responseBody: '{"status":false,"error":"unknown","detail":[]}',
};

function build(createImpl?: jest.Mock) {
  const create = createImpl ?? jest.fn().mockResolvedValue({});
  const prisma = { integrationApiLog: { create } };
  const service = new IntegrationLogService(prisma as never, loadIntegrationLogConfig({} as NodeJS.ProcessEnv));
  return { service, create };
}

/** The write is fire-and-forget; give the microtask queue a turn. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('IntegrationLogService', () => {
  it('persists a sanitized row: credentials and PII replaced, diagnostics kept', async () => {
    const { service, create } = build();
    service.record(ENTRY);
    await flush();

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    expect(data).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'GENERATE_CNOTE',
      direction: IntegrationDirection.OUTBOUND,
      operationId: 'op-1',
      attempt: 1,
      maxAttempts: 3,
      httpStatus: 200,
      durationMs: 3195,
      applicationOutcome: IntegrationOutcome.PARSE_FAILED,
      errorClass: 'parse_failed',
    });
    expect(data.sanitizedRequest).toMatchObject({ api_key: REDACTED, username: REDACTED, receiver_name: REDACTED_PII, order_no: 'BMS-1', destination_zip: '40112' });
    expect(JSON.stringify(data.sanitizedRequest)).not.toContain('SECRET');
    // The provider's actual answer survives — that is the point of the feature.
    expect(data.sanitizedResponse).toMatchObject({ status: false, error: 'unknown' });
  });

  it('respects the column widths (operation, errorClass, errorMessage, correlationId)', async () => {
    const { service, create } = build();
    service.record({ ...ENTRY, operation: 'X'.repeat(80), errorClass: 'y'.repeat(80), errorMessage: 'z'.repeat(900), correlationId: 'c'.repeat(200) });
    await flush();
    const { data } = create.mock.calls[0][0];
    expect(data.operation).toHaveLength(48);
    expect(data.errorClass).toHaveLength(32);
    // The marker counts towards the limit — the column is VarChar(512).
    expect(data.errorMessage.length).toBeLessThanOrEqual(512);
    expect(data.errorMessage).toMatch(/\[TRUNCATED\]$/);
    expect(data.correlationId).toHaveLength(128);
  });

  it('clamps the VarChar(36) id columns, leaving ordinary UUIDs untouched (review finding 5)', async () => {
    const uuid = '5088ee2c-8da2-444d-af62-e9202be315ba';
    const { service, create } = build();
    service.record({ ...ENTRY, orderId: uuid, paymentId: uuid, shipmentId: uuid });
    await flush();
    let { data } = create.mock.calls[0][0];
    expect(data.orderId).toBe(uuid);
    expect(data.paymentId).toBe(uuid);
    expect(data.shipmentId).toBe(uuid);
    expect(uuid).toHaveLength(36);

    const oversized = `${uuid}-and-then-some-trailing-garbage`;
    const second = build();
    second.service.record({ ...ENTRY, orderId: oversized, paymentId: oversized, shipmentId: oversized });
    await flush();
    data = second.create.mock.calls[0][0].data;
    for (const value of [data.orderId, data.paymentId, data.shipmentId]) {
      expect(value).toHaveLength(36);
      expect(value).toBe(uuid);
    }
  });

  it('sanitizes errorMessage with the payload policy — the provider body never lands raw (review finding 1)', async () => {
    const { service, create } = build();
    service.record({
      ...ENTRY,
      errorMessage: 'provider 400: username=masular&api_key=SUPERSECRETKEY123&order_no=BMS-1&receiver_phone=6285861470308',
    });
    await flush();
    const { data } = create.mock.calls[0][0];
    expect(data.errorMessage).not.toContain('SUPERSECRETKEY123');
    expect(data.errorMessage).not.toContain('masular');
    expect(data.errorMessage).not.toContain('6285861470308');
    expect(data.errorMessage).toContain('provider 400');
    expect(data.errorMessage).toContain('order_no=BMS-1');
  });

  it('a database failure is swallowed — record() resolves and nothing propagates', async () => {
    const failing = jest.fn().mockRejectedValue(new Error('connection terminated'));
    const { service } = build(failing);
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    expect(() => service.record(ENTRY)).not.toThrow();
    await flush();

    expect(failing).toHaveBeenCalled();
    // The ONLY consequence: a log line through the existing application logger.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ event: 'integration_log.persist_failed', operationId: 'op-1' }));
    spy.mockRestore();
  });

  it('a synchronous failure inside the recorder is swallowed too', async () => {
    const throwing = jest.fn(() => {
      throw new Error('client not initialised');
    });
    const { service } = build(throwing as unknown as jest.Mock);
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    expect(() => service.record(ENTRY)).not.toThrow();
    await flush();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('writes nothing when INTEGRATION_LOG_ENABLED=false', async () => {
    const create = jest.fn();
    const service = new IntegrationLogService({ integrationApiLog: { create } } as never, loadIntegrationLogConfig({ INTEGRATION_LOG_ENABLED: 'false' } as NodeJS.ProcessEnv));
    service.record(ENTRY);
    await flush();
    expect(create).not.toHaveBeenCalled();
  });

  it('sanitizes an already-parsed webhook payload (INBOUND) the same way', async () => {
    const { service, create } = build();
    service.record({
      provider: IntegrationProvider.MIDTRANS,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      operationId: 'op-2',
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      requestPayload: { order_id: 'BMS-1', gross_amount: '50000.00', signature_key: 'a'.repeat(128), customer_details: { email: 'buyer@example.com' } },
    });
    await flush();
    const { data } = create.mock.calls[0][0];
    expect(data.sanitizedRequest).toMatchObject({ order_id: 'BMS-1', gross_amount: '50000.00', signature_key: REDACTED });
    expect(JSON.stringify(data.sanitizedRequest)).not.toContain('buyer@example.com');
    expect(data.attempt).toBeNull();
  });

  it('stores the exchange EXACTLY as captured beside the sanitized copy: URL, request body, response body', async () => {
    const { service, create } = build();
    const endpoint = 'https://api.example.test/v2/charge?server_key=SECRET&token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig';
    const responseBody = '{\n  "error" : "Please do not let paramaters empty.",\n  "status" : false\n}\n';
    service.record({ ...ENTRY, endpoint, responseBody });
    await flush();
    const { data } = create.mock.calls[0][0];

    // Verbatim: credentials, PII, JWT, spacing and trailing newline all kept.
    expect(data.rawEndpoint).toBe(endpoint);
    expect(data.rawRequestBody).toBe(ENTRY.requestBody);
    expect(data.rawResponseBody).toBe(responseBody);
    // The sanitized columns are unchanged by it.
    expect(data.sanitizedRequest).toMatchObject({ username: REDACTED, api_key: REDACTED, receiver_name: REDACTED_PII });
    expect(data.endpoint).toContain('token=[REDACTED]');
    expect(data.rawEndpoint).toContain('token=eyJhbGciOiJIUzI1NiJ9');
  });

  it('never truncates the exact bodies, even far past the sanitized payload cap', async () => {
    const { service, create } = build();
    const requestBody = `api_key=SECRET&blob=${'a'.repeat(300_000)}`;
    const responseBody = JSON.stringify({ data: 'b'.repeat(300_000), phone: '6285861470308' });
    service.record({ ...ENTRY, requestBody, responseBody });
    await flush();
    const { data } = create.mock.calls[0][0];
    expect(data.rawRequestBody).toBe(requestBody);
    expect(data.rawResponseBody).toBe(responseBody);
    expect(JSON.stringify(data.sanitizedResponse).length).toBeLessThan(responseBody.length);
  });

  it('an empty body stays "", a missing one stays null - nothing is reconstructed from a parsed payload', async () => {
    const { service, create } = build();
    service.record({ ...ENTRY, requestBody: '', responseBody: undefined, endpoint: undefined });
    service.record({
      provider: IntegrationProvider.MIDTRANS,
      operation: 'charge',
      direction: IntegrationDirection.OUTBOUND,
      operationId: 'op-3',
      applicationOutcome: IntegrationOutcome.REJECTED,
      responsePayload: { status_code: '406', status_message: 'duplicate order_id' },
    });
    await flush();
    const [first, second] = create.mock.calls.map((c) => c[0].data);
    expect(first).toMatchObject({ rawRequestBody: '', rawResponseBody: null, rawEndpoint: null });
    expect(second).toMatchObject({ rawRequestBody: null, rawResponseBody: null });
    expect(second.sanitizedResponse).toMatchObject({ status_code: '406' });
  });

  it('an INBOUND webhook keeps its raw body verbatim while the sanitized column comes from the parsed payload', async () => {
    const { service, create } = build();
    const raw = '{"order_id":"BMS-1","signature_key":"' + 'a'.repeat(128) + '","customer_details":{"email":"buyer@example.com"}}';
    service.record({
      provider: IntegrationProvider.MIDTRANS,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      operationId: 'op-4',
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      requestPayload: JSON.parse(raw),
      requestBody: raw,
      responseBody: '{"received":true,"handled":false}',
    });
    await flush();
    const { data } = create.mock.calls[0][0];
    expect(data.rawRequestBody).toBe(raw);
    expect(data.rawResponseBody).toBe('{"received":true,"handled":false}');
    expect(data.sanitizedRequest).toMatchObject({ signature_key: REDACTED });
    expect(JSON.stringify(data.sanitizedRequest)).not.toContain('buyer@example.com');
  });
});
