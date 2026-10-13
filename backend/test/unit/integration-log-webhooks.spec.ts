import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider } from '@prisma/client';
import { JneWebhookController } from '../../src/modules/shipment/presentation/jne-webhook.controller';
import { PaxelWebhookController } from '../../src/modules/shipment/presentation/paxel-webhook.controller';
import { PaymentWebhookController } from '../../src/modules/payments/gateway/presentation/payment-webhook.controller';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';

/**
 * INBOUND webhook logging. Recorded AFTER the existing service has decided, so
 * signature verification, dedup, replay protection and the response bodies are
 * exactly what they were - each case asserts the provider-facing answer too.
 */

function recorder() {
  const entries: IntegrationLogEntry[] = [];
  return { entries, record: (e: IntegrationLogEntry) => entries.push(e) };
}

const resStub = () => {
  const r = { statusCode: 0, status(code: number) { r.statusCode = code; return r; } };
  return r;
};

describe('JNE webhook', () => {
  const BODY = { awb: 'JNE00099', order_id: 'BMS-1', status: 'DELIVERED', signature: 'https://cdn.jne/sig.png' };

  it('records one INBOUND row and returns the unchanged 200 body', async () => {
    const rec = recorder();
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { status: true } }) };
    const controller = new JneWebhookController(service as never, rec as never);
    const res = resStub();

    await expect(controller.jne(BODY, 'application/json', res as never)).resolves.toEqual({ status: true });
    expect(res.statusCode).toBe(200);
    expect(service.handle).toHaveBeenCalledWith(BODY);

    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      correlationId: 'JNE00099',
      method: 'POST',
      endpoint: '/api/v1/shipments/webhook/jne',
    });
    expect(rec.entries[0].requestPayload).toEqual(BODY);
    expect(rec.entries[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a refusal is recorded as REJECTED with the provider-facing reason, response unchanged', async () => {
    const rec = recorder();
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn().mockResolvedValue({ httpStatus: 404, body: { status: false, reason: 'unknown AWB' } }) };
    const res = resStub();
    await expect(new JneWebhookController(service as never, rec as never).jne(BODY, 'application/json', res as never)).resolves.toEqual({
      status: false,
      reason: 'unknown AWB',
    });
    expect(res.statusCode).toBe(404);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 404, applicationOutcome: IntegrationOutcome.REJECTED, errorMessage: 'unknown AWB' });
  });

  it('the 415 content-type guard still short-circuits before the service, and is recorded', async () => {
    const rec = recorder();
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn() };
    const res = resStub();
    await new JneWebhookController(service as never, rec as never).jne(BODY, 'text/plain', res as never);
    expect(service.handle).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(415);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 415, applicationOutcome: IntegrationOutcome.REJECTED });
  });

  it('works with no recorder wired at all', async () => {
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { status: true } }) };
    await expect(new JneWebhookController(service as never).jne(BODY, 'application/json', resStub() as never)).resolves.toEqual({ status: true });
  });
});

describe('Paxel webhook', () => {
  const BODY = { airwaybill_code: 'PXL123', latest_status: 'ON_PROCESS' };

  it('records INBOUND without ever receiving the signature header', async () => {
    const rec = recorder();
    const service = { handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { received: true } }) };
    const res = resStub();

    await new PaxelWebhookController(service as never, rec as never).paxel(BODY, 'application/json', 'sha256=deadbeefsignature', res as never);

    // The signature still reaches the VERIFIER, unchanged...
    expect(service.handle).toHaveBeenCalledWith(BODY, { contentType: 'application/json', signature: 'sha256=deadbeefsignature' });
    // ...but never the log.
    expect(JSON.stringify(rec.entries)).not.toContain('deadbeefsignature');
    expect(rec.entries[0]).toMatchObject({ provider: IntegrationProvider.PAXEL, operation: 'WEBHOOK', direction: IntegrationDirection.INBOUND, correlationId: 'PXL123' });
  });

  it('an invalid signature is recorded as REJECTED and the 401 body is untouched', async () => {
    const rec = recorder();
    const service = { handle: jest.fn().mockResolvedValue({ httpStatus: 401, body: { received: false, reason: 'signature invalid' } }) };
    const res = resStub();
    const out = await new PaxelWebhookController(service as never, rec as never).paxel(BODY, 'application/json', 'bad', res as never);
    expect(out).toEqual({ received: false, reason: 'signature invalid' });
    expect(res.statusCode).toBe(401);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 401, applicationOutcome: IntegrationOutcome.REJECTED, errorMessage: 'signature invalid' });
  });
});

describe('Midtrans webhook', () => {
  const BODY = {
    order_id: 'BMS-20260914-QSVGENC3',
    status_code: '200',
    gross_amount: '50000.00',
    transaction_status: 'settlement',
    signature_key: 'f'.repeat(128),
  };

  it('records INBOUND and redacts signature_key through the sanitizer', async () => {
    const rec = recorder();
    const service = { handleMidtransNotification: jest.fn().mockResolvedValue({ handled: false }) };
    const out = await new PaymentWebhookController(service as never, rec as never).midtrans(BODY);

    expect(out).toEqual({ received: true, handled: false });
    expect(service.handleMidtransNotification).toHaveBeenCalled();
    expect(rec.entries[0]).toMatchObject({
      provider: IntegrationProvider.MIDTRANS,
      operation: 'WEBHOOK',
      direction: IntegrationDirection.INBOUND,
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      correlationId: 'BMS-20260914-QSVGENC3',
    });
    // The raw payload is handed over; `signature_key` is a sensitive KEY, so the
    // recorder's sanitizer replaces it (integration-log-recorder.spec asserts that).
    expect((rec.entries[0].requestPayload as Record<string, unknown>).signature_key).toBe('f'.repeat(128));
  });

  it('a rejected notification is recorded with its status and rethrown UNCHANGED', async () => {
    const rec = recorder();
    const service = { handleMidtransNotification: jest.fn().mockRejectedValue(new UnauthorizedException('invalid signature')) };

    await expect(new PaymentWebhookController(service as never, rec as never).midtrans(BODY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 401, applicationOutcome: IntegrationOutcome.REJECTED });
    expect(rec.entries[0].errorMessage).toContain('invalid signature');
  });

  it('a malformed body is rejected by the webhook validation exactly as before', async () => {
    const rec = recorder();
    const service = { handleMidtransNotification: jest.fn() };
    await expect(new PaymentWebhookController(service as never, rec as never).midtrans({ order_id: 'x' })).rejects.toBeDefined();
    expect(service.handleMidtransNotification).not.toHaveBeenCalled();
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.REJECTED });
  });
});

describe('exact inbound exchange (req.rawBody -> rawRequestBody, the sent JSON -> rawResponseBody)', () => {
  const raw = (text: string) => ({ rawBody: Buffer.from(text, 'utf8') });

  it('JNE: the raw bytes as received and the JSON actually answered', async () => {
    const rec = recorder();
    const text = '{ "awb" : "JNE00099",\n  "receiver_phone": "6285861470308" }';
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn().mockResolvedValue({ httpStatus: 404, body: { status: false, reason: 'unknown AWB' } }) };
    await new JneWebhookController(service as never, rec as never).jne(JSON.parse(text), 'application/json', resStub() as never, raw(text));
    expect(rec.entries[0].requestBody).toBe(text);
    expect(rec.entries[0].responseBody).toBe('{"status":false,"reason":"unknown AWB"}');
  });

  it('JNE 415: the raw body and the rejection body are both kept', async () => {
    const rec = recorder();
    await new JneWebhookController({ checkSource: jest.fn().mockReturnValue(null), handle: jest.fn() } as never, rec as never).jne({}, 'text/plain', resStub() as never, raw('awb=JNE1'));
    expect(rec.entries[0]).toMatchObject({ requestBody: 'awb=JNE1', responseBody: '{"status":false,"reason":"Content-Type must be application/json"}' });
  });

  it('Paxel: raw body kept verbatim; the signature HEADER is still never recorded', async () => {
    const rec = recorder();
    const text = '{"airwaybill_code":"PXL123","receiver":{"name":"Budi Santoso"}}';
    const service = { handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { received: true } }) };
    await new PaxelWebhookController(service as never, rec as never).paxel(JSON.parse(text), 'application/json', 'sha256=deadbeefsignature', resStub() as never, raw(text));
    expect(rec.entries[0]).toMatchObject({ requestBody: text, responseBody: '{"received":true}' });
    expect(JSON.stringify(rec.entries)).not.toContain('deadbeefsignature');
  });

  it('Midtrans: raw body verbatim (signature_key included) and the exact ack; a rejection keeps the request body', async () => {
    const text = JSON.stringify({ order_id: 'BMS-20260914-QSVGENC3', status_code: '200', gross_amount: '50000.00', transaction_status: 'settlement', signature_key: 'f'.repeat(128) });
    const ok = recorder();
    await new PaymentWebhookController({ handleMidtransNotification: jest.fn().mockResolvedValue({}) } as never, ok as never).midtrans(JSON.parse(text), raw(text));
    expect(ok.entries[0]).toMatchObject({ requestBody: text, responseBody: '{"received":true,"handled":false}' });

    const bad = recorder();
    await expect(
      new PaymentWebhookController({ handleMidtransNotification: jest.fn().mockRejectedValue(new UnauthorizedException('invalid signature')) } as never, bad as never).midtrans(JSON.parse(text), raw(text)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // The error body is written later by the exception filter: not captured, never invented.
    expect(bad.entries[0]).toMatchObject({ requestBody: text, responseBody: null });
  });

  it('without req.rawBody nothing is reconstructed from the parsed body', async () => {
    const rec = recorder();
    const service = { checkSource: jest.fn().mockReturnValue(null), handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { status: true } }) };
    await new JneWebhookController(service as never, rec as never).jne({ awb: 'JNE1' }, 'application/json', resStub() as never);
    expect(rec.entries[0].requestBody).toBeNull();
  });
});
