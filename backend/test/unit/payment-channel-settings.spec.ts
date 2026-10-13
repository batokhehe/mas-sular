import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GatewayTransactionStatus, PaymentMethod, PaymentStatus } from '@prisma/client';
import { validateEnv } from '../../src/common/config/env.validation';
import {
  GLOBAL_SERVICE_FEE_ENV,
  loadPaymentChannelAvailability,
  loadPaymentServiceFeeSettings,
  PAYMENT_CHANNEL_ENV,
  PAYMENT_CHANNEL_ENV_KEYS,
  paymentChannelSettingIssues,
  SEABANK_VA_ENV,
  serviceFeeSettingFor,
} from '../../src/modules/payments/gateway/domain/payment-channel-settings';
import { PAYMENT_CHANNELS } from '../../src/modules/payments/gateway/domain/payment-channel';
import { calculatePaymentServiceFee } from '../../src/modules/payments/gateway/domain/payment-service-fee';
import { midtransSupportedChannels } from '../../src/modules/payments/gateway/domain/midtrans-channel.map';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';
import { PaymentInitiationService } from '../../src/modules/payments/gateway/payment-initiation.service';
import { feeSettingFor, loadPaymentServiceFeeConfig } from '../../src/modules/payments/gateway/payment-service-fee.config';
import { PaymentProvider } from '../../src/modules/payments/gateway/domain/payment-provider.interface';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Env-controlled payment channel availability (PAYMENT_<channel>_ENABLED) and
 * per-channel service fee pass-through (PAYMENT_FEE_<channel>_ENABLED). No database,
 * no gateway: providers and Prisma are stubs.
 */

const STAGING_TARGET: Record<string, string> = {
  PAYMENT_TRANSFER_ENABLED: 'false',
  PAYMENT_QRIS_ENABLED: 'true',
  PAYMENT_EWALLET_GOPAY_ENABLED: 'true',
  PAYMENT_EWALLET_SHOPEEPAY_ENABLED: 'true',
  PAYMENT_VA_BCA_ENABLED: 'false',
  PAYMENT_VA_BNI_ENABLED: 'false',
  PAYMENT_VA_BRI_ENABLED: 'true',
  PAYMENT_VA_MANDIRI_ENABLED: 'true',
  PAYMENT_VA_PERMATA_ENABLED: 'false',
  PAYMENT_VA_SEABANK_ENABLED: 'false',
  PAYMENT_CREDIT_CARD_ENABLED: 'false',
  PAYMENT_FEE_TRANSFER_ENABLED: 'false',
  PAYMENT_FEE_QRIS_ENABLED: 'false',
  PAYMENT_FEE_EWALLET_GOPAY_ENABLED: 'false',
  PAYMENT_FEE_EWALLET_SHOPEEPAY_ENABLED: 'false',
  PAYMENT_FEE_VA_BCA_ENABLED: 'false',
  PAYMENT_FEE_VA_BNI_ENABLED: 'false',
  PAYMENT_FEE_VA_BRI_ENABLED: 'false',
  PAYMENT_FEE_VA_MANDIRI_ENABLED: 'false',
  PAYMENT_FEE_VA_PERMATA_ENABLED: 'false',
  PAYMENT_FEE_VA_SEABANK_ENABLED: 'false',
  PAYMENT_FEE_CREDIT_CARD_ENABLED: 'false',
};

/** A bootable production-shaped env (same fixture shape as jne-environment-guard.spec). */
const BOOTABLE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://u:p@db:5432/app',
  REDIS_URL: 'redis://redis:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ADMIN_ACCESS_SECRET: 'c'.repeat(32),
  GOOGLE_CLIENT_ID: 'google-client-id',
  APP_URL: 'https://shop.example.com',
  CORS_ORIGINS: 'https://shop.example.com',
  CHECKOUT_IDEMPOTENCY_ENABLED: 'true',
  TRUST_PROXY_HOPS: '1',
};

describe('variable -> channel mapping', () => {
  it('every catalog channel has exactly the documented pair of variables', () => {
    expect(PAYMENT_CHANNEL_ENV).toEqual({
      MANUAL_TRANSFER: { availability: 'PAYMENT_TRANSFER_ENABLED', fee: 'PAYMENT_FEE_TRANSFER_ENABLED' },
      QRIS: { availability: 'PAYMENT_QRIS_ENABLED', fee: 'PAYMENT_FEE_QRIS_ENABLED' },
      GOPAY: { availability: 'PAYMENT_EWALLET_GOPAY_ENABLED', fee: 'PAYMENT_FEE_EWALLET_GOPAY_ENABLED' },
      SHOPEEPAY: { availability: 'PAYMENT_EWALLET_SHOPEEPAY_ENABLED', fee: 'PAYMENT_FEE_EWALLET_SHOPEEPAY_ENABLED' },
      BCA_VA: { availability: 'PAYMENT_VA_BCA_ENABLED', fee: 'PAYMENT_FEE_VA_BCA_ENABLED' },
      BNI_VA: { availability: 'PAYMENT_VA_BNI_ENABLED', fee: 'PAYMENT_FEE_VA_BNI_ENABLED' },
      BRI_VA: { availability: 'PAYMENT_VA_BRI_ENABLED', fee: 'PAYMENT_FEE_VA_BRI_ENABLED' },
      MANDIRI_BILL: { availability: 'PAYMENT_VA_MANDIRI_ENABLED', fee: 'PAYMENT_FEE_VA_MANDIRI_ENABLED' },
      PERMATA_VA: { availability: 'PAYMENT_VA_PERMATA_ENABLED', fee: 'PAYMENT_FEE_VA_PERMATA_ENABLED' },
      CREDIT_CARD: { availability: 'PAYMENT_CREDIT_CARD_ENABLED', fee: 'PAYMENT_FEE_CREDIT_CARD_ENABLED' },
    });
    expect(Object.keys(PAYMENT_CHANNEL_ENV).sort()).toEqual(PAYMENT_CHANNELS.map((c) => c.code).sort());
    expect(SEABANK_VA_ENV).toEqual({ availability: 'PAYMENT_VA_SEABANK_ENABLED', fee: 'PAYMENT_FEE_VA_SEABANK_ENABLED' });
  });

  it('fee variables never reuse a channel variable name (22 distinct keys)', () => {
    expect(PAYMENT_CHANNEL_ENV_KEYS).toHaveLength(22);
    expect(new Set(PAYMENT_CHANNEL_ENV_KEYS).size).toBe(22);
    expect(PAYMENT_CHANNEL_ENV_KEYS.filter((k) => k.startsWith('PAYMENT_FEE_'))).toHaveLength(11);
    expect(Object.keys(STAGING_TARGET).sort()).toEqual([...PAYMENT_CHANNEL_ENV_KEYS].sort());
  });
});

describe('defaults keep today\'s behavior', () => {
  it('availability: absent = enabled; explicit values are honoured', () => {
    expect(Object.values(loadPaymentChannelAvailability({}).enabled).every(Boolean)).toBe(true);
    const target = loadPaymentChannelAvailability(STAGING_TARGET).enabled;
    expect(target).toEqual({
      MANUAL_TRANSFER: false, QRIS: true, GOPAY: true, SHOPEEPAY: true, BCA_VA: false,
      BNI_VA: false, BRI_VA: true, MANDIRI_BILL: true, PERMATA_VA: false, CREDIT_CARD: false,
    });
  });

  it('fee: absent = inherit PAYMENT_SERVICE_FEE_ENABLED; an explicit channel flag wins either way', () => {
    const matrix: Array<[string | undefined, string | undefined, boolean, 'CHANNEL' | 'GLOBAL']> = [
      [undefined, undefined, false, 'GLOBAL'],
      ['false', undefined, false, 'GLOBAL'],
      ['true', undefined, true, 'GLOBAL'],
      ['false', 'true', true, 'CHANNEL'],
      ['true', 'false', false, 'CHANNEL'],
      ['true', 'true', true, 'CHANNEL'],
      ['false', 'false', false, 'CHANNEL'],
    ];
    for (const [global, own, enabled, source] of matrix) {
      const settings = loadPaymentServiceFeeSettings({ PAYMENT_SERVICE_FEE_ENABLED: global, PAYMENT_FEE_VA_BRI_ENABLED: own });
      expect([global, own, serviceFeeSettingFor(settings, 'BRI_VA')]).toEqual([
        global, own, { enabled, source, variable: source === 'CHANNEL' ? 'PAYMENT_FEE_VA_BRI_ENABLED' : GLOBAL_SERVICE_FEE_ENV },
      ]);
    }
    // Another channel is unaffected by BRI's own flag.
    const settings = loadPaymentServiceFeeSettings({ PAYMENT_SERVICE_FEE_ENABLED: 'true', PAYMENT_FEE_VA_BRI_ENABLED: 'false' });
    expect(serviceFeeSettingFor(settings, 'BNI_VA')).toEqual({ enabled: true, variable: GLOBAL_SERVICE_FEE_ENV, source: 'GLOBAL' });
    expect(serviceFeeSettingFor(settings, null)).toEqual({ enabled: true, variable: GLOBAL_SERVICE_FEE_ENV, source: 'GLOBAL' });
  });

  it('the injected config keeps its old `{ enabled }` shape working', () => {
    expect(feeSettingFor({ enabled: true }, 'GOPAY')).toEqual({ enabled: true, variable: GLOBAL_SERVICE_FEE_ENV, source: 'GLOBAL' });
    expect(loadPaymentServiceFeeConfig({ PAYMENT_SERVICE_FEE_ENABLED: 'true', PAYMENT_FEE_EWALLET_GOPAY_ENABLED: 'false' } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      channels: { GOPAY: false },
    });
  });
});

describe('boot validation', () => {
  it('the staging target (SeaBank off) with Midtrans on boots', () => {
    expect(() => validateEnv({ ...BOOTABLE, ...STAGING_TARGET, MIDTRANS_ENABLED: 'true', MIDTRANS_SERVER_KEY: 'k', MIDTRANS_CLIENT_KEY: 'c' })).not.toThrow();
    expect(paymentChannelSettingIssues({ ...STAGING_TARGET, MIDTRANS_ENABLED: 'true' })).toEqual([]);
  });

  it('an env without any of the new variables boots exactly as before', () => {
    expect(() => validateEnv(BOOTABLE)).not.toThrow();
    expect(paymentChannelSettingIssues({})).toEqual([]);
  });

  it.each(PAYMENT_CHANNEL_ENV_KEYS.map((k) => [k]))('%s accepts only "true" / "false"', (key) => {
    for (const bad of ['yes', '1', 'TRUE', 'on', '']) {
      expect(() => validateEnv({ ...BOOTABLE, [key]: bad })).toThrow(new RegExp(key));
    }
  });

  it('SeaBank VA is refused (not implemented), for availability and fee alike', () => {
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_VA_SEABANK_ENABLED: 'true' })).toThrow(/PAYMENT_VA_SEABANK_ENABLED=true: SeaBank VA is not implemented/);
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_FEE_VA_SEABANK_ENABLED: 'true' })).toThrow(/PAYMENT_FEE_VA_SEABANK_ENABLED=true: SeaBank VA is not implemented/);
  });

  it('QRIS and CREDIT_CARD fee pass-through can never be switched on', () => {
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_FEE_QRIS_ENABLED: 'true' })).toThrow(/PAYMENT_FEE_QRIS_ENABLED=true: the QRIS service fee may never be charged to the customer/);
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_FEE_CREDIT_CARD_ENABLED: 'true' })).toThrow(/PAYMENT_FEE_CREDIT_CARD_ENABLED=true: the CREDIT_CARD service fee may never be charged/);
    // false is fine, and the inherited global switch keeps its existing (blocked) handling.
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_FEE_QRIS_ENABLED: 'false', PAYMENT_SERVICE_FEE_ENABLED: 'true' })).not.toThrow();
  });

  it('manual transfer has no fee rule, so its pass-through cannot be switched on', () => {
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_FEE_TRANSFER_ENABLED: 'true' })).toThrow(/PAYMENT_FEE_TRANSFER_ENABLED=true: MANUAL_TRANSFER has no service fee rule/);
  });

  it('ALLOWED channels may pass the fee on', () => {
    for (const key of ['PAYMENT_FEE_EWALLET_GOPAY_ENABLED', 'PAYMENT_FEE_EWALLET_SHOPEEPAY_ENABLED', 'PAYMENT_FEE_VA_BCA_ENABLED', 'PAYMENT_FEE_VA_BNI_ENABLED', 'PAYMENT_FEE_VA_BRI_ENABLED', 'PAYMENT_FEE_VA_MANDIRI_ENABLED', 'PAYMENT_FEE_VA_PERMATA_ENABLED']) {
      expect(() => validateEnv({ ...BOOTABLE, [key]: 'true' })).not.toThrow();
    }
  });

  it('boot fails when nothing is left to pay with', () => {
    const allOff = Object.fromEntries(Object.values(PAYMENT_CHANNEL_ENV).map((v) => [v.availability, 'false']));
    expect(() => validateEnv({ ...BOOTABLE, ...allOff, MIDTRANS_ENABLED: 'true', MIDTRANS_SERVER_KEY: 'k', MIDTRANS_CLIENT_KEY: 'c' })).toThrow(/Every payment channel is disabled/);
    // Manual transfer off and the gateway off: gateway channels "on" cannot be used.
    expect(() => validateEnv({ ...BOOTABLE, PAYMENT_TRANSFER_ENABLED: 'false' })).toThrow(/PAYMENT_TRANSFER_ENABLED=false and MIDTRANS_ENABLED is not true/);
    // One usable channel is enough.
    expect(() => validateEnv({ ...BOOTABLE, ...allOff, PAYMENT_TRANSFER_ENABLED: 'true' })).not.toThrow();
  });
});

// ------------------------------------------------------------------ registry --

function registryWith(env: Record<string, string>, opts: { midtransReady?: boolean; midtransRegistered?: boolean } = {}) {
  const manual = { name: 'manual', supportedChannels: () => ['MANUAL_TRANSFER'], isReady: async () => true };
  const midtrans = { name: 'midtrans', supportedChannels: () => midtransSupportedChannels(), isReady: async () => opts.midtransReady ?? true };
  const providers = opts.midtransRegistered === false ? [manual] : [manual, midtrans];
  return new PaymentChannelRegistry(new PaymentProviderFactory(providers as unknown as PaymentProvider[]), loadPaymentChannelAvailability(env));
}

describe('channel availability (registry)', () => {
  it('a disabled channel is hidden from GET /payments/channels', async () => {
    const codes = (await registryWith(STAGING_TARGET).listPublic()).map((c) => c.code);
    expect(codes.sort()).toEqual(['BRI_VA', 'GOPAY', 'MANDIRI_BILL', 'QRIS', 'SHOPEEPAY']);
  });

  it('a disabled channel is REJECTED at initiation (resolve), whatever the client sends', () => {
    const registry = registryWith(STAGING_TARGET);
    for (const code of ['MANUAL_TRANSFER', 'BCA_VA', 'BNI_VA', 'PERMATA_VA', 'CREDIT_CARD', 'SEABANK_VA']) {
      expect(() => registry.resolve(code)).toThrow(NotFoundException);
    }
    expect(registry.resolve('BRI_VA').channel.code).toBe('BRI_VA');
  });

  it('enabled by env but the provider is not registered or not ready: still unavailable', async () => {
    expect(registryWith(STAGING_TARGET, { midtransRegistered: false }).listAvailable()).toEqual([]);
    expect(await registryWith(STAGING_TARGET, { midtransReady: false }).listPublic()).toEqual([]);
  });

  it('absent variables: every channel stays offered exactly as before', async () => {
    expect((await registryWith({}).listPublic()).map((c) => c.code)).toEqual(PAYMENT_CHANNELS.map((c) => c.code));
  });

  it('find() still returns a disabled channel, so an OPEN payment on it can be described', () => {
    expect(registryWith(STAGING_TARGET).find('BNI_VA')?.code).toBe('BNI_VA');
  });
});

describe('an open payment on a channel switched off later', () => {
  it('resume (payment page) still rebuilds the attempt and never contacts the gateway', async () => {
    const createCharge = jest.fn();
    const provider = { name: 'midtrans', supportedChannels: () => midtransSupportedChannels(), createCharge, getStatus: jest.fn(), cancel: jest.fn(), mapStatus: jest.fn() };
    const factory = new PaymentProviderFactory([provider as unknown as PaymentProvider]);
    const registry = new PaymentChannelRegistry(factory, loadPaymentChannelAvailability({ PAYMENT_VA_BNI_ENABLED: 'false' }));
    const prisma = { payment: { findFirst: jest.fn().mockResolvedValue({ id: 'pay-1', status: PaymentStatus.PENDING, order: { userId: 'user-1' }, orderId: 'o-1' }) } };
    const ledger = {
      findLatestByPayment: jest.fn().mockResolvedValue({
        id: 'gtx-1', paymentId: 'pay-1', provider: 'midtrans', channelCode: 'BNI_VA', status: GatewayTransactionStatus.PENDING,
        grossAmount: 40_000, providerOrderId: 'BMS-1-a1b2c3d4', providerReference: 'ref-1', providerTransactionId: 'txn-1',
        qrString: null, vaNumber: '9881234567890', redirectUrl: null, deeplinkUrl: null, expiryAt: new Date(Date.now() + 3_600_000),
      }),
    };
    const service = new PaymentInitiationService(prisma as never, registry, factory, ledger as never);

    const result = await service.getInstructions('pay-1', 'user-1');
    expect(result.gateway).not.toBeNull();
    expect(JSON.stringify(result.gateway)).toContain('9881234567890');
    expect(createCharge).not.toHaveBeenCalled();

    // Status checks resolve by the payment's provider, never through channel availability.
    prisma.payment.findFirst.mockResolvedValue({ id: 'pay-1', provider: 'midtrans', providerReference: 'ref-1' });
    await service.refreshStatus('pay-1');
    expect(provider.getStatus).toHaveBeenCalledWith({ paymentId: 'pay-1', providerReference: 'ref-1' });
  });

  it('but a NEW charge on it is refused before anything is written', async () => {
    const factory = new PaymentProviderFactory([{ name: 'midtrans', supportedChannels: () => midtransSupportedChannels() } as unknown as PaymentProvider]);
    const registry = new PaymentChannelRegistry(factory, loadPaymentChannelAvailability({ PAYMENT_VA_BNI_ENABLED: 'false' }));
    const prisma = {
      payment: { findFirst: jest.fn().mockResolvedValue({ id: 'pay-1', orderId: 'o-1', method: PaymentMethod.GATEWAY, status: PaymentStatus.PENDING, amount: 30_000, order: { orderNumber: 'BMS-1', totalPrice: 30_000, paymentServiceFee: 0, user: null } }) },
    };
    const ledger = { createPendingTransaction: jest.fn() };
    const service = new PaymentInitiationService(prisma as never, registry, factory, ledger as never);
    await expect(service.initiate('pay-1', 'BNI_VA')).rejects.toBeInstanceOf(NotFoundException);
    expect(ledger.createPendingTransaction).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------- fees --

describe('per-channel fee pass-through', () => {
  const base = 30_000;

  it('flag false: customer pays Rp0, the merchant cost is still calculated and recorded with its variable', () => {
    const setting = feeSettingFor({ enabled: true, channels: { BRI_VA: false } }, 'BRI_VA');
    const fee = calculatePaymentServiceFee({ paymentChannel: 'BRI_VA', transactionBase: base, feeEnabled: setting.enabled, setting });
    expect(fee).toMatchObject({ feeEnabled: false, calculatedFee: 4_000, customerFee: 0, merchantAbsorbedFee: 4_000, customerTotal: base });
    expect(fee.rule?.setting).toEqual({ enabled: false, variable: 'PAYMENT_FEE_VA_BRI_ENABLED', source: 'CHANNEL' });
  });

  it('flag true on an ALLOWED channel: customer total = base + fee (the amount the gateway is charged)', () => {
    const setting = feeSettingFor({ enabled: false, channels: { GOPAY: true } }, 'GOPAY');
    const fee = calculatePaymentServiceFee({ paymentChannel: 'GOPAY', transactionBase: base, feeEnabled: setting.enabled, setting });
    expect(fee).toMatchObject({ feeEnabled: true, calculatedFee: 600, customerFee: 600, merchantAbsorbedFee: 0, customerTotal: 30_600 });
    expect(fee.rule?.setting).toEqual({ enabled: true, variable: 'PAYMENT_FEE_EWALLET_GOPAY_ENABLED', source: 'CHANNEL' });
  });

  it('QRIS inheriting a global true is still never charged to the customer', () => {
    const setting = feeSettingFor({ enabled: true }, 'QRIS');
    const fee = calculatePaymentServiceFee({ paymentChannel: 'QRIS', transactionBase: base, feeEnabled: setting.enabled, setting });
    expect(fee).toMatchObject({ customerFee: 0, merchantAbsorbedFee: 210, passThroughBlockedReason: 'PASS_THROUGH_PROHIBITED:QRIS' });
    expect(fee.rule?.setting).toEqual({ enabled: true, variable: 'PAYMENT_SERVICE_FEE_ENABLED', source: 'GLOBAL' });
  });

  it('without a setting the snapshot is exactly the previous shape (no `setting` key)', () => {
    const fee = calculatePaymentServiceFee({ paymentChannel: 'BRI_VA', transactionBase: base, feeEnabled: false });
    expect(fee.rule).not.toHaveProperty('setting');
  });

  it('initiation charges the gateway exactly the per-channel customer total and records the deciding variable', async () => {
    const provider = {
      name: 'midtrans',
      supportedChannels: () => midtransSupportedChannels(),
      createCharge: jest.fn().mockRejectedValue(new Error('stop after pricing')),
    };
    const factory = new PaymentProviderFactory([provider as unknown as PaymentProvider]);
    const registry = new PaymentChannelRegistry(factory, loadPaymentChannelAvailability({}));
    const prisma = {
      payment: { findFirst: jest.fn().mockResolvedValue({ id: 'pay-1', orderId: 'o-1', method: PaymentMethod.GATEWAY, status: PaymentStatus.PENDING, amount: 30_000, order: { orderNumber: 'BMS-1', totalPrice: 30_000, paymentServiceFee: 0, user: null } }) },
    };
    const pricing = { openPricedAttempt: jest.fn().mockResolvedValue({ id: 'gtx-1', grossAmount: 34_000 }) };
    const ledger = { markFailed: jest.fn() };
    const service = new PaymentInitiationService(
      prisma as never, registry, factory, ledger as never, undefined as never,
      { enabled: false, channels: { BNI_VA: true } } as never, pricing as never,
    );

    await service.initiate('pay-1', 'BNI_VA').catch(() => undefined);

    const priced = pricing.openPricedAttempt.mock.calls[0][0];
    expect(priced.grossAmount).toBe(34_000);
    expect(priced.serviceFee).toMatchObject({ customerFee: 4_000, feeEnabled: true, channel: 'BNI_VA' });
    expect(priced.serviceFee.rule.setting).toEqual({ enabled: true, variable: 'PAYMENT_FEE_VA_BNI_ENABLED', source: 'CHANNEL' });
    expect(provider.createCharge.mock.calls[0][0].amount).toBe(34_000);
  });
});

// --------------------------------------------------------------- checkout --

describe('checkout refuses a disabled channel before the order exists', () => {
  function checkout(env: Record<string, string>) {
    const prisma = { $transaction: jest.fn(), product: { findMany: jest.fn() } };
    const registry = registryWith(env);
    const service = new OrdersService(
      prisma as never, {} as never, {} as never, {} as never,
      undefined, undefined, undefined, undefined,
      { initiate: jest.fn() } as never, registry, { enabled: false },
    );
    return { service, prisma };
  }
  const run = (service: OrdersService, dto: Record<string, unknown>) =>
    (service as unknown as { runCheckout(u: string, d: unknown, i: null, f: null): Promise<unknown> }).runCheckout('user-1', { items: [], ...dto }, null, null);

  it('GATEWAY + a disabled channel: 400, nothing is read or written', async () => {
    const { service, prisma } = checkout(STAGING_TARGET);
    await expect(run(service, { payment_method: PaymentMethod.GATEWAY, payment_channel: 'BNI_VA' })).rejects.toThrow(BadRequestException);
    await expect(run(service, { payment_method: PaymentMethod.GATEWAY, payment_channel: 'NOT_A_CHANNEL' })).rejects.toThrow(/not available right now/);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('BANK_TRANSFER (or the omitted default) with PAYMENT_TRANSFER_ENABLED=false: 400', async () => {
    const { service, prisma } = checkout(STAGING_TARGET);
    await expect(run(service, { payment_method: PaymentMethod.BANK_TRANSFER })).rejects.toThrow(/Transfer Bank is not available/);
    await expect(run(service, {})).rejects.toThrow(/Transfer Bank is not available/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('an enabled channel passes the guard (the checkout continues to the cart)', async () => {
    const { service, prisma } = checkout(STAGING_TARGET);
    prisma.product.findMany.mockRejectedValue(new Error('reached the cart'));
    await expect(run(service, { payment_method: PaymentMethod.GATEWAY, payment_channel: 'BRI_VA', items: [{ product_id: 'p1', quantity: 1 }] })).rejects.toThrow('reached the cart');
  });
});
