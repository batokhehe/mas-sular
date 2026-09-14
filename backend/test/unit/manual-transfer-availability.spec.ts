/**
 * P0-3 — "Transfer Bank" (MANUAL_TRANSFER) is offered, and a new BANK_TRANSFER
 * order accepted, only while an active, usable PaymentAccount exists. Without one
 * the order could be placed but never paid (nowhere to transfer to).
 *
 * The source of truth is the backend: GET /payments/channels (registry.listPublic)
 * and the checkout guard share one readiness check - ManualTransferProvider.isReady,
 * which reads the SAME active account createCharge() and the notifications use.
 * Gateway (Midtrans) channels are unaffected.
 */
import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { ConfigurationError } from '../../src/common/errors/configuration.error';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { PaymentProvider } from '../../src/modules/payments/gateway/domain/payment-provider.interface';
import { ManualTransferProvider } from '../../src/modules/payments/gateway/infrastructure/providers/manual-transfer.provider';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';
import { PaymentChannelsController } from '../../src/modules/payments/gateway/presentation/payment-channels.controller';

const ACCOUNT = { id: 'acc-1', bankName: 'BCA', bankCode: '014', accountName: 'Mas Sular', accountNumber: '1234567890' };
const NO_ACCOUNT = () => Promise.reject(new ConfigurationError('No active payment account configured'));

function manual(getActiveAccount: jest.Mock) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ManualTransferProvider({} as any, { getActiveAccount } as any);
}

/** The gateway as MIDTRANS_ENABLED=true registers it: every gateway channel. */
const midtrans = {
  name: 'midtrans',
  supportedChannels: () => ['QRIS', 'GOPAY', 'SHOPEEPAY', 'BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA', 'CREDIT_CARD'],
} as unknown as PaymentProvider;

const registryWith = (...providers: PaymentProvider[]) => new PaymentChannelRegistry(new PaymentProviderFactory(providers));
const codes = async (registry: PaymentChannelRegistry) => (await registry.listPublic()).map((c) => c.code);

describe('GET /payments/channels - manual transfer needs an active account', () => {
  it('0 active accounts: MANUAL_TRANSFER is hidden, every Midtrans channel still appears', async () => {
    const registry = registryWith(manual(jest.fn(NO_ACCOUNT)), midtrans);
    const list = await codes(registry);
    expect(list).not.toContain('MANUAL_TRANSFER');
    expect(list).toEqual(['QRIS', 'GOPAY', 'SHOPEEPAY', 'BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA', 'CREDIT_CARD']);
  });

  it('an active account: MANUAL_TRANSFER is offered alongside Midtrans (unchanged public shape)', async () => {
    const registry = registryWith(manual(jest.fn().mockResolvedValue(ACCOUNT)), midtrans);
    const channels = await registry.listPublic();
    expect(channels.map((c) => c.code)[0]).toBe('MANUAL_TRANSFER');
    expect(channels).toHaveLength(10);
    const manualChannel = channels.find((c) => c.code === 'MANUAL_TRANSFER')!;
    expect(manualChannel).toMatchObject({ label: 'Transfer Bank', method: PaymentMethod.BANK_TRANSFER, group: 'MANUAL' });
    // Account details are NOT in the catalog: they reach the customer through the
    // existing payment instructions (createCharge) exactly as before.
    expect(JSON.stringify(channels)).not.toContain(ACCOUNT.accountNumber);
    expect(manualChannel).not.toHaveProperty('provider');
  });

  it('an "active" account missing its number/name/bank is not usable - hidden', async () => {
    for (const broken of [{ accountNumber: '' }, { accountName: '   ' }, { bankName: '' }]) {
      const registry = registryWith(manual(jest.fn().mockResolvedValue({ ...ACCOUNT, ...broken })), midtrans);
      expect(await codes(registry)).not.toContain('MANUAL_TRANSFER');
    }
  });

  it('fails CLOSED: a readiness error hides only that channel and never breaks the list', async () => {
    const registry = registryWith(manual(jest.fn().mockRejectedValue(new Error('db connection reset'))), midtrans);
    const list = await codes(registry);
    expect(list).not.toContain('MANUAL_TRANSFER');
    expect(list).toContain('QRIS');
  });

  it('manual transfer only (Midtrans off) with no account: an empty list, not a dead option', async () => {
    expect(await codes(registryWith(manual(jest.fn(NO_ACCOUNT))))).toEqual([]);
    expect(await codes(registryWith(manual(jest.fn().mockResolvedValue(ACCOUNT))))).toEqual(['MANUAL_TRANSFER']);
  });

  it('the account is re-read per request: activating one in admin shows the channel without a restart', async () => {
    const getActiveAccount = jest.fn().mockImplementationOnce(NO_ACCOUNT).mockResolvedValue(ACCOUNT);
    const registry = registryWith(manual(getActiveAccount), midtrans);
    expect(await codes(registry)).not.toContain('MANUAL_TRANSFER');
    expect(await codes(registry)).toContain('MANUAL_TRANSFER');
  });

  it('the controller returns the awaited, readiness-filtered list', async () => {
    const registry = registryWith(manual(jest.fn(NO_ACCOUNT)), midtrans);
    const controller = new PaymentChannelsController(registry, {} as never);
    const body = await controller.list();
    expect(body.channels.map((c) => c.code)).not.toContain('MANUAL_TRANSFER');
    expect(body.channels.length).toBe(9);
  });

  it('readiness is read-only: it only reads the active account', async () => {
    const getActiveAccount = jest.fn().mockResolvedValue(ACCOUNT);
    await expect(manual(getActiveAccount).isReady()).resolves.toBe(true);
    expect(getActiveAccount).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Checkout: the backend refuses a new manual-transfer order it cannot complete.
// ---------------------------------------------------------------------------

function checkoutService(registry: PaymentChannelRegistry | undefined) {
  const order = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: { id: 'pay-1', amount: 30000 } };
  const tx = {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(order) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    product: { findMany: jest.fn().mockResolvedValue([{ id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 }]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'addr-1', userId: 'user-1', deletedAt: null, provinceId: 'p', cityId: 'c',
        districtId: 'd', villageId: 'v', postalCode: '40131', latitude: -6.9, longitude: 107.6,
      }),
    },
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 }) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/raw' }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any,
    undefined, undefined, undefined, undefined,
    undefined, registry,
    { enabled: false },
  );
  return { service, prisma };
}

const dto = (over: Partial<CreateOrderDto> = {}): CreateOrderDto => ({
  address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 1 }], ...over,
});

describe('checkout - BANK_TRANSFER requires a ready manual transfer', () => {
  it('0 active accounts: explicit BANK_TRANSFER is refused before pricing or any write', async () => {
    const { service, prisma } = checkoutService(registryWith(manual(jest.fn(NO_ACCOUNT)), midtrans));
    await expect(service.checkout('user-1', dto({ payment_method: PaymentMethod.BANK_TRANSFER }))).rejects.toThrow(
      new BadRequestException('Transfer Bank is not available right now. Please choose another payment method.'),
    );
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('0 active accounts: the omitted-method default (BANK_TRANSFER) is refused too', async () => {
    const { service, prisma } = checkoutService(registryWith(manual(jest.fn(NO_ACCOUNT)), midtrans));
    await expect(service.checkout('user-1', dto())).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('0 active accounts: a GATEWAY order is untouched by the guard', async () => {
    const { service, prisma } = checkoutService(registryWith(manual(jest.fn(NO_ACCOUNT)), midtrans));
    await service.checkout('user-1', dto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'QRIS' }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('an active account: BANK_TRANSFER checkout proceeds exactly as before', async () => {
    const { service, prisma } = checkoutService(registryWith(manual(jest.fn().mockResolvedValue(ACCOUNT)), midtrans));
    await service.checkout('user-1', dto({ payment_method: PaymentMethod.BANK_TRANSFER }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
