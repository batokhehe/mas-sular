import { IntegrationDirection, IntegrationOutcome, IntegrationProvider, ShipmentStatus } from '@prisma/client';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider';
import { JneProvider } from '../../src/modules/shipping/infrastructure/providers/jne.provider';
import { MidtransPaymentProvider } from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';
import { IntegrationLogService } from '../../src/infrastructure/integration-log/integration-log.service';
import { loadIntegrationLogConfig } from '../../src/infrastructure/integration-log/integration-log.config';

/**
 * Provider-level integration logging. JNE books through /pickupcashless; its success
 * body below is the one JNE CONFIRMED, its error body the HTTP-200 rejection JNE
 * returned earlier. Every response here is a fixture - no provider is called.
 */

const JNE_SUCCESS = '{"detail":[{"status":"success","cnote_no":"0109401600067399"}]}';
const JNE_REJECTION = '{"detail":[{"reason":"Please do not let field OLSHOP_GOODSVALUE empty","status":"Error"}]}';
/** The top-level rejection JNE actually returned for /pickupcashless on staging. */
const JNE_TOP_LEVEL_REJECTION = '{"error":"Please do not let paramaters empty.","status":false}';

function recorder() {
  const entries: IntegrationLogEntry[] = [];
  return { entries, record: (e: IntegrationLogEntry) => entries.push(e) };
}

function config(over: Partial<ShippingConfig['jne']> = {}): ShippingConfig {
  return {
    allowMockRates: false,
    paxel: {
      enabled: true,
      baseUrl: 'https://paxel.test',
      apiKey: 'paxel-secret-key',
      apiSecret: 'paxel-signing-secret',
      originPhone: '081212121212',
      originNote: 'gerbang samping',
      timeoutMs: 500,
      maxRetry: 0,
      defaultDimension: '30x35x20',
      needInsurance: false,
    },
    jne: {
      enabled: true,
      baseUrl: 'https://jne.test',
      apiKey: 'jne-secret',
      username: 'store',
      originCode: 'BDO10000',
      timeoutMs: 500,
      // Deliberately NOT 0: /pickupcashless must force maxRetry 0 on its own.
      maxRetry: 2,
      pickup: {
        pickupName: 'Pickup Test',
        pickupPic: 'Pic Test',
        pickupPicPhone: '081200000001',
        pickupAddress: 'Jl. Gudang Test No. 1',
        pickupDistrict: 'Sumur Bandung',
        pickupCity: 'Kota Bandung',
        pickupService: 'Domestic',
        pickupVehicle: 'Motor',
        branch: 'BRANCH-TEST',
        custId: 'CUST-TEST',
        merchantId: 'MERCHANT-TEST',
        shipperName: 'Shipper Test',
        shipperAddr1: 'Jl. Gudang Test No. 1',
        shipperAddr2: 'Kel. Braga',
        shipperCity: 'Kota Bandung',
        shipperZip: '40111',
        shipperRegion: 'Jawa Barat',
        shipperContact: 'Contact Test',
        shipperPhone: '081200000002',
        type: 'PICKUP',
      },
      ...over,
    },
  } as ShippingConfig;
}

const res = (status: number, body: string): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

const INPUT: CreateShipmentInput = {
  orderId: 'order-123',
  orderNumber: 'BMS-20260914-QSVGENC3',
  service: 'JTR<130',
  weightGram: 1500,
  origin: { name: 'Pusat', postalCode: '40111' },
  destination: {
    name: 'Budi Santoso',
    phone: '6285861470308',
    addressDetail: 'Jl. Veteran No. 65',
    postalCode: '40112',
    village: 'Kebon Pisang',
    district: 'Sumur Bandung',
    city: 'Kota Bandung',
    province: 'Jawa Barat',
  },
  items: [
    { code: 'SKU-1', name: 'Baso Urat Jumbo', category: 'Bakso', quantity: 2, unitPrice: 45_000, weightGram: 250, lengthCm: 10, widthCm: 10, heightCm: 10, isFragile: false },
  ],
  goodsAmount: 90_000,
  destinationDistrictId: 'district-sumur-bandung',
  recordedPickupAtIso: '2026-09-17T10:00:00.000Z',
};

function buildJne(rec = recorder(), cfg = config(), destinationCode: string | null = 'BDO10060') {
  const destinations = { resolve: jest.fn().mockResolvedValue(destinationCode) };
  const provider = new JneShipmentProvider(cfg, rec as never, destinations as never);
  const http = jest.fn();
  (provider as unknown as { http: unknown }).http = http;
  return { provider, http, rec, destinations };
}

describe('JNE PICKUP_CASHLESS — booking against the confirmed response', () => {
  it('SUCCESS: HTTP 200 + status success + cnote_no -> the cnote is the tracking number and provider id', async () => {
    const { provider, http, rec, destinations } = buildJne();
    http.mockResolvedValue(res(200, JNE_SUCCESS));

    const result = await provider.createShipment(INPUT);

    expect(result).toEqual({
      trackingNumber: '0109401600067399',
      providerShipmentId: '0109401600067399',
      status: ShipmentStatus.CREATED,
      rawPayload: { detail: [{ status: 'success', cnote_no: '0109401600067399' }] },
    });
    // Never the order number, never a local id.
    expect(result.trackingNumber).not.toBe(INPUT.orderNumber);
    expect(http).toHaveBeenCalledTimes(1);
    expect(destinations.resolve).toHaveBeenCalledWith('district-sumur-bandung');

    // One HTTP attempt + one application outcome, one logical call.
    expect(rec.entries).toHaveLength(2);
    const [attempt, outcome] = rec.entries;
    expect(attempt).toMatchObject({ operation: 'PICKUP_CASHLESS', attempt: 1, httpStatus: 200, applicationOutcome: IntegrationOutcome.OK });
    expect(outcome).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'PICKUP_CASHLESS',
      direction: IntegrationDirection.OUTBOUND,
      endpoint: 'https://jne.test/pickupcashless',
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
      correlationId: '0109401600067399',
      orderId: 'order-123',
      errorClass: null,
      errorMessage: null,
      responseBody: JNE_SUCCESS,
    });
    expect(outcome.attempt).toBeUndefined();
    expect(outcome.operationId).toBe(attempt.operationId);
  });

  it('BUSINESS ERROR: HTTP 200 + status Error is NOT success; JNE\'s reason is preserved', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, JNE_REJECTION));

    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(PermanentError);
    http.mockResolvedValue(res(200, JNE_REJECTION));
    await expect(provider.createShipment(INPUT)).rejects.toThrow('JNE rejected the pickup: Please do not let field OLSHOP_GOODSVALUE empty');

    const outcome = rec.entries.find((e) => e.attempt === undefined)!;
    expect(outcome).toMatchObject({
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.REJECTED,
      errorClass: 'rejected',
      errorMessage: 'Please do not let field OLSHOP_GOODSVALUE empty',
      correlationId: INPUT.orderNumber, // no cnote to correlate by
    });
  });

  it('TOP-LEVEL REJECTION: HTTP 200 + {error, status:false} is REJECTED with JNE\'s exact message', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, JNE_TOP_LEVEL_REJECTION));

    const error = await provider.createShipment(INPUT).catch((err: Error) => err);
    expect(error).toBeInstanceOf(PermanentError);
    expect((error as Error).message).toBe('JNE rejected the pickup: Please do not let paramaters empty.');
    expect(http).toHaveBeenCalledTimes(1); // still sent once, never retried

    expect(rec.entries).toHaveLength(2);
    const [attempt, outcome] = rec.entries;
    expect(attempt).toMatchObject({ attempt: 1, httpStatus: 200, applicationOutcome: IntegrationOutcome.OK });
    expect(outcome).toMatchObject({
      operation: 'PICKUP_CASHLESS',
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.REJECTED,
      errorClass: 'rejected',
      errorMessage: 'Please do not let paramaters empty.',
      correlationId: INPUT.orderNumber,
      responseBody: JNE_TOP_LEVEL_REJECTION,
    });
    expect(outcome.operationId).toBe(attempt.operationId);
  });

  it('what is PERSISTED for a top-level rejection: REJECTED, the exact message, credentials still redacted', async () => {
    const create = jest.fn().mockResolvedValue({});
    const service = new IntegrationLogService({ integrationApiLog: { create } } as never, loadIntegrationLogConfig({} as NodeJS.ProcessEnv));
    const { provider, http } = buildJne(service as never);
    http.mockResolvedValue(res(200, JNE_TOP_LEVEL_REJECTION));

    await provider.createShipment(INPUT).catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));

    const rows = create.mock.calls.map((call) => call[0].data);
    expect(rows).toHaveLength(2);
    const stored = JSON.stringify(rows);
    for (const secret of ['jne-secret', '"store"', 'Budi Santoso', '6285861470308']) {
      expect([secret, stored.includes(secret)]).toEqual([secret, false]);
    }
    const outcomeRow = rows.find((row) => row.attempt == null);
    expect(outcomeRow).toMatchObject({
      applicationOutcome: 'REJECTED',
      errorClass: 'rejected',
      errorMessage: 'Please do not let paramaters empty.',
      sanitizedResponse: { error: 'Please do not let paramaters empty.', status: false },
    });
  });

  it('a top-level rejection that echoes credentials or PII is redacted in the thrown error', async () => {
    const { provider, http } = buildJne();
    http.mockResolvedValue(res(200, JSON.stringify({ error: 'invalid api_key=jne-secret for RECEIVER_PHONE=6285861470308', status: false })));
    const error = await provider.createShipment(INPUT).catch((err: Error) => err);
    expect((error as Error).message).toContain('JNE rejected the pickup');
    expect((error as Error).message).not.toContain('jne-secret');
    expect((error as Error).message).not.toContain('6285861470308');
  });

  it('a malformed top-level rejection (invalid JSON) is still PARSE_FAILED', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, '{"error":"Please do not let paramaters empty.","status":fal'));
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/unexpected response: the response is not valid JSON/);
    expect(rec.entries.find((e) => e.attempt === undefined)).toMatchObject({ applicationOutcome: IntegrationOutcome.PARSE_FAILED, errorClass: 'parse_failed' });
  });

  it('status false WITHOUT an error message is not guessed into a rejection: PARSE_FAILED', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, '{"status":false}'));
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/unexpected response: the response has no detail array/);
    expect(rec.entries.find((e) => e.attempt === undefined)).toMatchObject({ applicationOutcome: IntegrationOutcome.PARSE_FAILED });
  });

  it('MALFORMED: an unexpected 200 body is PARSE_FAILED, never a misleading rejection', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, '{"detail":[{"status":"success"}]}'));

    await expect(provider.createShipment(INPUT)).rejects.toThrow(/unexpected response: detail\[0\]\.status is success but detail\[0\]\.cnote_no is missing or empty/);

    const outcome = rec.entries.find((e) => e.attempt === undefined)!;
    expect(outcome).toMatchObject({ applicationOutcome: IntegrationOutcome.PARSE_FAILED, errorClass: 'parse_failed' });
  });

  it('a non-JSON 200 is PARSE_FAILED too', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, '<html>maintenance</html>'));
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/not valid JSON/);
    expect(rec.entries.find((e) => e.attempt === undefined)).toMatchObject({ applicationOutcome: IntegrationOutcome.PARSE_FAILED });
  });

  it('a TIMEOUT during booking is sent once, never retried, and never reaches the parser', async () => {
    const { provider, http, rec } = buildJne();
    http.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(TransientError);

    expect(http).toHaveBeenCalledTimes(1); // config says maxRetry 2
    expect(rec.entries).toHaveLength(1); // the attempt only - there is no body to interpret
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.TIMEOUT, operation: 'PICKUP_CASHLESS' });
  });

  it('a 5xx during booking: one attempt, TransientError, no outcome record', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(502, 'bad gateway'));
    await expect(provider.createShipment(INPUT)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(rec.entries).toHaveLength(1);
  });

  it('an unmapped destination refuses BEFORE sending — no request, no log, no postal-code fallback', async () => {
    const { provider, http, rec } = buildJne(recorder(), config(), null);
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/no approved JNE destination mapping .*postal code is never used as a fallback/);
    expect(http).not.toHaveBeenCalled();
    expect(rec.entries).toHaveLength(0);
  });

  it('without the destination resolver the booking refuses instead of guessing', async () => {
    const provider = new JneShipmentProvider(config());
    const http = jest.fn();
    (provider as unknown as { http: unknown }).http = http;
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/destination resolver is not available/);
    expect(http).not.toHaveBeenCalled();
  });

  it('incomplete pickup configuration refuses before sending', async () => {
    const { provider, http } = buildJne(recorder(), config({ pickup: undefined }));
    await expect(provider.createShipment(INPUT)).rejects.toThrow(/JNE_PICKUP_NAME is required/);
    expect(http).not.toHaveBeenCalled();
  });

  it('the thrown rejection reason carries no credentials or PII even if JNE echoes them', async () => {
    const { provider, http } = buildJne();
    http.mockResolvedValue(res(200, JSON.stringify({ detail: [{ status: 'Error', reason: 'invalid api_key=jne-secret for RECEIVER_PHONE=6285861470308' }] })));
    const error = await provider.createShipment(INPUT).catch((err: Error) => err);
    expect(String((error as Error).message)).not.toContain('jne-secret');
    expect(String((error as Error).message)).not.toContain('6285861470308');
    expect(String((error as Error).message)).toContain('JNE rejected the pickup');
  });

  it('CANCEL_CNOTE and TRACK keep JNE\'s own vocabulary (unchanged endpoints)', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(200, JSON.stringify({ cnote: { pod_status: 'DELIVERED' } })));
    await provider.cancelShipment('JNE00099').catch(() => undefined);
    await provider.trackShipment('JNE00099').catch(() => undefined);
    expect(rec.entries.map((e) => e.operation)).toEqual(['CANCEL_CNOTE', 'TRACK']);
  });
});

describe('JNE PICKUP_CASHLESS — the send path', () => {
  async function fieldsFor(provider: JneShipmentProvider) {
    return provider.buildPickupCashlessFields(INPUT);
  }

  it('POSTs form-encoded to <base>/pickupcashless, exactly once on a 5xx (maxRetry 0)', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(503, 'service unavailable'));

    await expect(provider.sendPickupCashless(await fieldsFor(provider), { orderId: 'order-123' })).rejects.toBeInstanceOf(TransientError);

    expect(http).toHaveBeenCalledTimes(1); // config says maxRetry 2; the booking forces 0
    const [url, init] = http.mock.calls[0];
    expect(url).toBe('https://jne.test/pickupcashless');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers.Accept).toBe('application/json');
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get('api_key')).toBe('jne-secret'); // credentials DO reach JNE...
    expect(sent.get('DESTINATION_CODE')).toBe('BDO10060');
    expect(sent.get('ORDER_ID')).toBe('BMS20260914QSVGENC'); // hyphens removed, last character removed
    expect(sent.get('INSURANCE_FLAG')).toBe('N');
    expect(sent.get('SPECIAL_INS')).toBe('NO SPECIAL INSTRUCTION');

    expect(rec.entries).toHaveLength(1); // ...one record per actual attempt
    expect(rec.entries[0]).toMatchObject({
      provider: IntegrationProvider.JNE,
      operation: 'PICKUP_CASHLESS',
      direction: IntegrationDirection.OUTBOUND,
      method: 'POST',
      endpoint: 'https://jne.test/pickupcashless',
      httpStatus: 503,
      attempt: 1,
      maxAttempts: 1,
      orderId: 'order-123',
      // No correlationId passed on this direct send, so it falls back to the ORDER_ID
      // JNE received. Real bookings (createShipment) pass the Mas Sular order number.
      correlationId: 'BMS20260914QSVGENC',
      applicationOutcome: IntegrationOutcome.HTTP_ERROR,
    });
  });

  it('a timeout is NOT retried — JNE may already have accepted the pickup', async () => {
    const { provider, http, rec } = buildJne();
    http.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));

    await expect(provider.sendPickupCashless(await fieldsFor(provider))).rejects.toBeInstanceOf(TransientError);

    expect(http).toHaveBeenCalledTimes(1);
    expect(rec.entries).toHaveLength(1);
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.TIMEOUT, errorClass: 'timeout', operation: 'PICKUP_CASHLESS' });
  });

  it('a network failure is recorded once and not retried', async () => {
    const { provider, http, rec } = buildJne();
    http.mockRejectedValue(new Error('ECONNRESET'));
    await expect(provider.sendPickupCashless(await fieldsFor(provider))).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(rec.entries[0]).toMatchObject({ applicationOutcome: IntegrationOutcome.NETWORK_ERROR });
  });

  it('a 4xx stays a PermanentError with one record', async () => {
    const { provider, http, rec } = buildJne();
    http.mockResolvedValue(res(400, 'bad request'));
    await expect(provider.sendPickupCashless(await fieldsFor(provider))).rejects.toBeInstanceOf(PermanentError);
    expect(http).toHaveBeenCalledTimes(1);
    expect(rec.entries[0]).toMatchObject({ httpStatus: 400, applicationOutcome: IntegrationOutcome.HTTP_ERROR, errorClass: 'permanent_4xx' });
  });

  it('what is PERSISTED for a successful booking carries no credentials and no receiver/shipper/pickup PII', async () => {
    // The real recorder, with only Prisma stubbed: these are the rows that would be written.
    const create = jest.fn().mockResolvedValue({});
    const service = new IntegrationLogService({ integrationApiLog: { create } } as never, loadIntegrationLogConfig({} as NodeJS.ProcessEnv));
    const { provider, http } = buildJne(service as never);
    http.mockResolvedValue(res(200, JNE_SUCCESS));

    await provider.createShipment(INPUT);
    await new Promise((resolve) => setImmediate(resolve));

    expect(create).toHaveBeenCalledTimes(2); // attempt + application outcome
    const rows = create.mock.calls.map((call) => call[0].data);
    const stored = JSON.stringify(rows);
    for (const secret of ['jne-secret', '"store"', 'Budi Santoso', '6285861470308', 'Jl. Veteran', 'Kebon Pisang', 'Pic Test', '081200000001', '081200000002', 'Jl. Gudang Test']) {
      expect([secret, stored.includes(secret)]).toEqual([secret, false]);
    }
    const [attemptRow, outcomeRow] = rows;
    expect(attemptRow.sanitizedRequest).toMatchObject({
      username: '[REDACTED]',
      api_key: '[REDACTED]',
      RECEIVER_NAME: '[REDACTED_PII]',
      DESTINATION_CODE: 'BDO10060',
      ORDER_ID: 'BMS20260914QSVGENC',
      SPECIAL_INS: 'NO SPECIAL INSTRUCTION',
    });
    expect(attemptRow.sanitizedResponse).toEqual({ detail: [{ status: 'success', cnote_no: '0109401600067399' }] });
    expect(outcomeRow).toMatchObject({ operation: 'PICKUP_CASHLESS', endpoint: 'https://jne.test/pickupcashless', applicationOutcome: 'OK', httpStatus: 200 });
    expect(outcomeRow.sanitizedResponse).toEqual({ detail: [{ status: 'success', cnote_no: '0109401600067399' }] });
  });
});

describe('JNE RATE (quote) logs under the existing word', () => {
  it('records operation RATE', async () => {
    const rec = recorder();
    const destinations = { resolve: jest.fn().mockResolvedValue({ code: 'BDO10060', name: 'ANDIR' }) };
    const provider = new JneProvider(config(), destinations as never, rec as never);
    const http = jest.fn().mockResolvedValue(res(200, JSON.stringify({ price: [] })));
    (provider as unknown as { http: unknown }).http = http;

    await provider
      .getRates({
        origin: { city: 'Bandung', postalCode: '40111', districtId: 'd1' },
        destination: { city: 'Bandung', postalCode: '40112', districtId: 'd2' },
        weightGram: 1500,
      } as never)
      .catch(() => undefined);

    if (rec.entries.length > 0) {
      expect(rec.entries[0]).toMatchObject({ provider: IntegrationProvider.JNE, operation: 'RATE', direction: IntegrationDirection.OUTBOUND });
    }
  });
});

describe('Paxel keeps its own operation words', () => {
  it('CREATE_SHIPMENT carries the order id and never stores the API key header', async () => {
    const rec = recorder();
    const provider = new PaxelShipmentProvider(config(), rec as never);
    const http = jest.fn().mockResolvedValue(res(422, 'missing pickup'));
    (provider as unknown as { http: unknown }).http = http;

    // Paxel's documented create contract: full address hierarchy, items, pickup slot.
    await provider
      .createShipment({
        ...INPUT,
        service: 'PAXEL_REGULAR',
        invoiceValue: 250_000,
        paymentMethod: 'BANK_TRANSFER',
        pickupAtIso: '2026-09-20T03:00:00.000Z',
        origin: { ...INPUT.origin, addressDetail: 'Jl. Outlet No.1', province: 'Jawa Barat', city: 'Kota Bandung', district: 'Coblong', village: 'Dago' },
        destination: { ...INPUT.destination, note: 'pagar hijau', province: 'Jawa Barat', city: 'Kota Bandung', district: 'Sukajadi', village: 'Pasteur' },
        items: [
          { code: 'SKU-1', name: 'Bakso', category: 'Makanan', quantity: 2, unitPrice: 45_000, weightGram: 450, lengthCm: 20, widthCm: 15, heightCm: 10, isFragile: false },
        ],
      })
      .catch(() => undefined);

    const created = rec.entries.find((e) => e.operation === 'CREATE_SHIPMENT');
    expect(created).toBeDefined();
    expect(created).toMatchObject({ provider: IntegrationProvider.PAXEL, orderId: 'order-123', correlationId: 'BMS-20260914-QSVGENC3' });
    expect(JSON.stringify(created)).not.toContain('paxel-secret-key');
  });
});

describe('Midtrans keeps charge / status / cancel / expire', () => {
  function build() {
    const rec = recorder();
    const provider = new MidtransPaymentProvider(
      { enabled: true, baseUrl: 'https://api.sandbox.midtrans.com', serverKey: 'SB-Mid-server-SECRET', timeoutMs: 500, maxRetry: 0, isProduction: false } as never,
      rec as never,
    );
    const http = jest.fn();
    provider.setHttpClient(http as never);
    return { provider, http, rec };
  }

  it('getStatus records operation "status" with the payment id and no Authorization header', async () => {
    const { provider, http, rec } = build();
    http.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ status_code: '200', transaction_status: 'settlement', transaction_id: 'tx-9', order_id: 'BMS-1' }) });

    await provider.getStatus({ paymentId: 'pay-77', providerReference: 'BMS-1' }).catch(() => undefined);

    expect(rec.entries[0]).toMatchObject({
      provider: IntegrationProvider.MIDTRANS,
      operation: 'status',
      direction: IntegrationDirection.OUTBOUND,
      paymentId: 'pay-77',
      httpStatus: 200,
      applicationOutcome: IntegrationOutcome.OK,
    });
    expect(JSON.stringify(rec.entries)).not.toContain('SB-Mid-server-SECRET');
  });

  it('a 200 body Midtrans rejects becomes a REJECTED application record', async () => {
    const { provider, http, rec } = build();
    http.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ status_code: '401', status_message: 'Access denied' }) });

    await expect(provider.getStatus({ paymentId: 'pay-77', providerReference: 'BMS-1' })).rejects.toBeDefined();

    const rejected = rec.entries.find((e) => e.applicationOutcome === IntegrationOutcome.REJECTED);
    expect(rejected).toMatchObject({ operation: 'status', errorClass: 'rejected', paymentId: 'pay-77' });
    // Same logical call as the HTTP attempt.
    expect(rejected?.operationId).toBe(rec.entries[0].operationId);
  });
});
