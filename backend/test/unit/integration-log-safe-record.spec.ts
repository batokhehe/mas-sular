import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { IntegrationDirection, IntegrationOutcome, IntegrationProvider, ShipmentStatus } from '@prisma/client';
import { safeRecord } from '../../src/infrastructure/integration-log/safe-record';
import { IntegrationLogEntry } from '../../src/infrastructure/integration-log/integration-log.types';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { MidtransPaymentProvider } from '../../src/modules/payments/gateway/infrastructure/providers/midtrans-payment.provider';
import { JneWebhookController } from '../../src/modules/shipment/presentation/jne-webhook.controller';
import { PaxelWebhookController } from '../../src/modules/shipment/presentation/paxel-webhook.controller';
import { PaymentWebhookController } from '../../src/modules/payments/gateway/presentation/payment-webhook.controller';
import { PermanentError, TransientError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { ShippingHttpResponse } from '../../src/modules/shipping/infrastructure/http/shipping-http-client';
import { CreateShipmentInput } from '../../src/modules/shipment/domain/shipment-provider.interface';

/**
 * Review finding 3: every call site records through ONE guarded helper, so a broken
 * recorder cannot change what a provider, a webhook or a payment does. Each case
 * below injects a recorder that throws synchronously and asserts the business
 * outcome is byte-for-byte what it is with a working recorder.
 */

const THROWING = {
  record: () => {
    throw new Error('recorder exploded');
  },
};

const ENTRY: IntegrationLogEntry = {
  provider: IntegrationProvider.JNE,
  operation: 'GENERATE_CNOTE',
  direction: IntegrationDirection.OUTBOUND,
  operationId: 'op-1',
  applicationOutcome: IntegrationOutcome.OK,
};

describe('safeRecord', () => {
  it('forwards the entry to a healthy recorder', () => {
    const entries: IntegrationLogEntry[] = [];
    safeRecord({ record: (e) => entries.push(e) }, ENTRY);
    expect(entries).toEqual([ENTRY]);
  });

  it('does nothing when no recorder is wired', () => {
    expect(() => safeRecord(undefined, ENTRY)).not.toThrow();
  });

  it('swallows a synchronous throw and reports it through the hook', () => {
    const onError = jest.fn();
    expect(() => safeRecord(THROWING, ENTRY, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'recorder exploded' }));
  });

  it('contains a rejected promise from a recorder that ignores the void contract', async () => {
    const onError = jest.fn();
    const rejecting = { record: () => Promise.reject(new Error('async failure')) as unknown as void };
    expect(() => safeRecord(rejecting, ENTRY, onError)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'async failure' }));
  });

  it('a reporter that itself throws cannot defeat the guarantee', () => {
    expect(() =>
      safeRecord(THROWING, ENTRY, () => {
        throw new Error('logger exploded');
      }),
    ).not.toThrow();
  });
});

// ------------------------------------------------------------- call sites --

const res = (status: number, body: string): ShippingHttpResponse => ({ status, text: async () => body, headers: { get: () => null } });

function shippingConfig(): ShippingConfig {
  return {
    allowMockRates: false,
    paxel: { enabled: true, baseUrl: 'https://paxel.test', apiKey: 'k', apiSecret: 's', originPhone: '0812', originNote: 'n', timeoutMs: 500, maxRetry: 0, defaultDimension: '30x35x20', needInsurance: false },
    jne: {
      enabled: true,
      baseUrl: 'https://jne.test',
      apiKey: 'jne-secret',
      username: 'store',
      originCode: 'BDO10000',
      timeoutMs: 500,
      maxRetry: 0,
      pickup: {
        pickupName: 'Pickup Test', pickupPic: 'Pic Test', pickupPicPhone: '081200000001', pickupAddress: 'Jl. Test',
        pickupDistrict: 'District Test', pickupCity: 'City Test', pickupService: 'Domestic', pickupVehicle: 'Motor',
        branch: 'BRANCH-TEST', custId: 'CUST-TEST', merchantId: 'MERCHANT-TEST',
        shipperName: 'Shipper Test', shipperAddr1: 'Jl. Test', shipperAddr2: 'Kel. Test', shipperCity: 'City Test',
        shipperZip: '40111', shipperRegion: 'Region Test', shipperContact: 'Contact Test', shipperPhone: '081200000002',
        type: 'PICKUP',
      },
    },
  } as ShippingConfig;
}

const INPUT: CreateShipmentInput = {
  orderId: 'order-123',
  orderNumber: 'BMS-1',
  service: 'JTR<130',
  weightGram: 1500,
  origin: { name: 'Pusat', postalCode: '40111' },
  destination: { name: 'Budi', phone: '628123', addressDetail: 'Jl. Test', postalCode: '40112', village: 'V', district: 'D', city: 'C', province: 'P' },
  items: [{ code: 'S', name: 'Bakso', category: 'x', quantity: 1, unitPrice: 1000, weightGram: 300, lengthCm: 1, widthCm: 1, heightCm: 1, isFragile: false }],
  goodsAmount: 1000,
  destinationDistrictId: 'district-1',
  recordedPickupAtIso: '2026-09-17T10:00:00.000Z',
};

describe('a throwing recorder changes nothing (the five call sites)', () => {
  function jne() {
    const destinations = { resolve: jest.fn().mockResolvedValue('BDO10060') };
    const provider = new JneShipmentProvider(shippingConfig(), THROWING as never, destinations as never);
    const http = jest.fn();
    (provider as unknown as { http: unknown }).http = http;
    return { provider, http };
  }

  it('JNE booking still returns the confirmed cnote', async () => {
    const { provider, http } = jne();
    http.mockResolvedValue(res(200, '{"detail":[{"status":"success","cnote_no":"0109401600067399"}]}'));
    await expect(provider.createShipment(INPUT)).resolves.toMatchObject({
      trackingNumber: '0109401600067399',
      providerShipmentId: '0109401600067399',
      status: ShipmentStatus.CREATED,
    });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('a JNE HTTP-200 rejection still throws the SAME PermanentError with JNE\'s reason', async () => {
    const { provider, http } = jne();
    http.mockResolvedValue(res(200, '{"detail":[{"reason":"Please do not let field OLSHOP_GOODSVALUE empty","status":"Error"}]}'));
    await expect(provider.createShipment(INPUT)).rejects.toThrow('JNE rejected the pickup: Please do not let field OLSHOP_GOODSVALUE empty');
  });

  it('the /pickupcashless send path keeps its classification and its single attempt', async () => {
    const { provider, http } = jne();
    http.mockResolvedValue(res(503, 'down'));
    const fields = await provider.buildPickupCashlessFields(INPUT);
    await expect(provider.sendPickupCashless(fields)).rejects.toBeInstanceOf(TransientError);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('Midtrans rejected-body handling still throws its own error', async () => {
    const provider = new MidtransPaymentProvider(
      { enabled: true, baseUrl: 'https://api.sandbox.midtrans.com', serverKey: 'SB-Mid-server-SECRET', timeoutMs: 500, maxRetry: 0, isProduction: false } as never,
      THROWING as never,
    );
    provider.setHttpClient((async () => ({ status: 200, text: async () => JSON.stringify({ status_code: '401', status_message: 'Access denied' }) })) as never);
    await expect(provider.getStatus({ paymentId: 'pay-1', providerReference: 'BMS-1' })).rejects.toThrow(/Access denied|401/);
  });

  it('the JNE webhook still answers exactly as before', async () => {
    const service = { handle: jest.fn().mockResolvedValue({ httpStatus: 200, body: { status: true } }) };
    const res200 = { statusCode: 0, status(code: number) { this.statusCode = code; return this; } };
    await expect(
      new JneWebhookController(service as never, THROWING as never).jne({ awb: 'JNE1' }, 'application/json', res200 as never),
    ).resolves.toEqual({ status: true });
    expect(res200.statusCode).toBe(200);
    expect(service.handle).toHaveBeenCalled();
  });

  it('the Paxel webhook still answers exactly as before (verification untouched)', async () => {
    const service = { handle: jest.fn().mockResolvedValue({ httpStatus: 401, body: { received: false, reason: 'signature invalid' } }) };
    const response = { statusCode: 0, status(code: number) { this.statusCode = code; return this; } };
    await expect(
      new PaxelWebhookController(service as never, THROWING as never).paxel({ airwaybill_code: 'PXL1' }, 'application/json', 'sig', response as never),
    ).resolves.toEqual({ received: false, reason: 'signature invalid' });
    expect(response.statusCode).toBe(401);
    expect(service.handle).toHaveBeenCalledWith({ airwaybill_code: 'PXL1' }, { contentType: 'application/json', signature: 'sig' });
  });

  it('the Midtrans webhook still acks — and still rethrows a rejection unchanged', async () => {
    const BODY = { order_id: 'BMS-1', status_code: '200', gross_amount: '50000.00', transaction_status: 'settlement', signature_key: 'f'.repeat(128) };

    const ok = { handleMidtransNotification: jest.fn().mockResolvedValue({ handled: false }) };
    await expect(new PaymentWebhookController(ok as never, THROWING as never).midtrans(BODY)).resolves.toEqual({ received: true, handled: false });

    const bad = { handleMidtransNotification: jest.fn().mockRejectedValue(new UnauthorizedException('invalid signature')) };
    await expect(new PaymentWebhookController(bad as never, THROWING as never).midtrans(BODY)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
