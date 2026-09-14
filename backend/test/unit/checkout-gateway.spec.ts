import { GatewayTransactionStatus, PaymentMethod, VoucherType } from '@prisma/client';
import { PAYMENT_CHANNELS, toPublicChannel } from '../../src/modules/payments/gateway/domain/payment-channel';
import {
  buildCheckoutGatewayPayload,
  buildGatewayPayloadFromLedger,
  buildPaymentInstruction,
} from '../../src/modules/payments/gateway/domain/payment-instruction.builder';
import { ChargeResult } from '../../src/modules/payments/gateway/domain/payment-provider.interface';

const descriptor = (code: string) => PAYMENT_CHANNELS.find((c) => c.code === code)!;

const charge = (over: Partial<ChargeResult> = {}): ChargeResult => ({
  provider: 'midtrans',
  channel: 'QRIS',
  providerReference: 'trx-9',
  providerTransactionId: 'trx-9',
  providerStatus: GatewayTransactionStatus.PENDING,
  status: 'PENDING' as never,
  expiresAt: new Date('2026-07-12T03:00:00.000Z'),
  instructions: { kind: 'QR', amount: 130000, qrString: 'QR-DATA', howTo: ['a', 'b'] },
  ...over,
});

describe('payment instruction builder — normalized customer contract', () => {
  it('QR: title + description exactly as specified', () => {
    const view = buildPaymentInstruction('QRIS', { kind: 'QR', amount: 1000, qrString: 'X', howTo: [] });
    expect(view).toMatchObject({
      type: 'QR',
      title: 'Scan QRIS',
      description: 'Scan menggunakan aplikasi e-wallet atau mobile banking.',
      qrString: 'X',
    });
  });

  it.each([
    ['BCA_VA', 'BCA'],
    ['BNI_VA', 'BNI'],
    ['BRI_VA', 'BRI'],
    ['MANDIRI_BILL', 'Mandiri'],
    ['PERMATA_VA', 'Permata'],
  ])('VA %s: exposes bank + number', (channel, bank) => {
    const view = buildPaymentInstruction(channel as never, { kind: 'VA', amount: 1000, vaNumber: '8808123', howTo: [] });
    expect(view).toMatchObject({ type: 'VA', bank, number: '8808123' });
  });

  it('DEEPLINK: per-wallet button text', () => {
    expect(buildPaymentInstruction('GOPAY', { kind: 'DEEPLINK', amount: 1, actionUrl: 'gojek://x', howTo: [] }))
      .toMatchObject({ type: 'DEEPLINK', buttonText: 'Buka GoPay', actionUrl: 'gojek://x' });
    expect(buildPaymentInstruction('SHOPEEPAY', { kind: 'DEEPLINK', amount: 1, howTo: [] }))
      .toMatchObject({ type: 'DEEPLINK', buttonText: 'Buka ShopeePay' });
  });

  it('REDIRECT: Bayar Sekarang', () => {
    expect(buildPaymentInstruction('CREDIT_CARD', { kind: 'REDIRECT', amount: 1, actionUrl: 'https://3ds', howTo: [] }))
      .toMatchObject({ type: 'REDIRECT', buttonText: 'Bayar Sekarang', actionUrl: 'https://3ds' });
  });

  it('MANUAL_TRANSFER keeps bank/account/uniqueCode for the existing page', () => {
    const view = buildPaymentInstruction('MANUAL_TRANSFER', {
      kind: 'MANUAL_TRANSFER', amount: 130321, bankName: 'BCA', accountName: 'Mas Sular',
      accountNumber: '123', uniqueCode: 321, howTo: ['x'],
    });
    expect(view).toMatchObject({ type: 'MANUAL_TRANSFER', bank: 'BCA', accountNumber: '123', uniqueCode: 321 });
  });

  it('never leaks a provider name into what the customer reads', () => {
    for (const code of PAYMENT_CHANNELS.map((c) => c.code)) {
      const view = buildPaymentInstruction(code, { kind: 'VA', amount: 1, vaNumber: '1', howTo: [] });
      expect(JSON.stringify(view).toLowerCase()).not.toContain('midtrans');
    }
  });
});

describe('checkout gateway payload — response normalization', () => {
  it('carries every additive field the checkout response promises', () => {
    const payload = buildCheckoutGatewayPayload(charge(), descriptor('QRIS'));
    expect(Object.keys(payload).sort()).toEqual([
      'amountBreakdown', 'deeplinkUrl', 'expiryAt', 'paymentChannel', 'paymentInstruction', 'paymentMethod',
      'provider', 'providerStatus', 'qrString', 'redirectUrl', 'vaNumber',
    ].sort());
    expect(payload).toMatchObject({
      paymentMethod: PaymentMethod.GATEWAY,
      paymentChannel: 'QRIS',
      provider: 'midtrans',
      providerStatus: GatewayTransactionStatus.PENDING,
      qrString: 'QR-DATA',
      expiryAt: '2026-07-12T03:00:00.000Z',
    });
  });

  it('carries the attempt\'s customer-facing amount breakdown (fresh charge and ledger rebuild), never the absorbed share', () => {
    const breakdown = { baseAmount: 105_000, serviceFee: 0, total: 105_000 };
    expect(buildCheckoutGatewayPayload(charge({ amountBreakdown: breakdown }), descriptor('QRIS')).amountBreakdown).toEqual(breakdown);
    expect(buildCheckoutGatewayPayload(charge(), descriptor('QRIS')).amountBreakdown).toBeNull();

    const row = {
      channelCode: 'BNI_VA', provider: 'midtrans', status: GatewayTransactionStatus.PENDING, grossAmount: 109_000,
      baseAmount: 105_000, serviceFeeCustomer: 4_000, vaNumber: '8808', qrString: null, redirectUrl: null, deeplinkUrl: null, expiryAt: null,
    };
    const rebuilt = buildGatewayPayloadFromLedger(row, descriptor('BNI_VA'));
    expect(rebuilt.amountBreakdown).toEqual({ baseAmount: 105_000, serviceFee: 4_000, total: 109_000 });
    expect(JSON.stringify(rebuilt)).not.toMatch(/bsorbed|Calculated/);
    // A legacy attempt with no snapshot rebuilds with no breakdown (unchanged behaviour).
    expect(buildGatewayPayloadFromLedger({ ...row, baseAmount: null }, descriptor('BNI_VA')).amountBreakdown).toBeNull();
  });

  it('routes the action URL to deeplinkUrl for wallets and redirectUrl otherwise', () => {
    const wallet = buildCheckoutGatewayPayload(
      charge({ channel: 'GOPAY', instructions: { kind: 'DEEPLINK', amount: 1, actionUrl: 'gojek://x', howTo: [] } }),
      descriptor('GOPAY'),
    );
    expect(wallet).toMatchObject({ deeplinkUrl: 'gojek://x', redirectUrl: null });

    const card = buildCheckoutGatewayPayload(
      charge({ channel: 'CREDIT_CARD', instructions: { kind: 'REDIRECT', amount: 1, actionUrl: 'https://3ds', howTo: [] } }),
      descriptor('CREDIT_CARD'),
    );
    expect(card).toMatchObject({ redirectUrl: 'https://3ds', deeplinkUrl: null });
  });

  it('a null expiry stays null (never an invalid date string)', () => {
    expect(buildCheckoutGatewayPayload(charge({ expiresAt: null }), descriptor('QRIS')).expiryAt).toBeNull();
  });
});

describe('ledger rebuild — payment page reload never re-charges', () => {
  const row = {
    channelCode: 'BCA_VA', provider: 'midtrans', status: GatewayTransactionStatus.PENDING,
    grossAmount: 130000, vaNumber: '8808123', qrString: null, redirectUrl: null,
    deeplinkUrl: null, expiryAt: new Date('2026-07-12T03:00:00.000Z'),
  };

  it('reconstructs a VA payload from persisted columns only', () => {
    const payload = buildGatewayPayloadFromLedger(row, descriptor('BCA_VA'));
    expect(payload).toMatchObject({
      paymentChannel: 'BCA_VA', vaNumber: '8808123', provider: 'midtrans',
      expiryAt: '2026-07-12T03:00:00.000Z',
    });
    expect(payload.paymentInstruction).toMatchObject({ type: 'VA', bank: 'BCA', number: '8808123' });
  });

  it('infers the instruction kind from whichever artifact was stored', () => {
    expect(buildGatewayPayloadFromLedger({ ...row, vaNumber: null, qrString: 'QR' }, descriptor('QRIS')).paymentInstruction.type).toBe('QR');
    expect(buildGatewayPayloadFromLedger({ ...row, vaNumber: null, deeplinkUrl: 'gojek://x' }, descriptor('GOPAY')).paymentInstruction.type).toBe('DEEPLINK');
    expect(buildGatewayPayloadFromLedger({ ...row, vaNumber: null, redirectUrl: 'https://3ds' }, descriptor('CREDIT_CARD')).paymentInstruction.type).toBe('REDIRECT');
  });
});

describe('channel catalog metadata for the storefront', () => {
  it('every channel ships icon + sortOrder so the UI hardcodes nothing', () => {
    for (const channel of PAYMENT_CHANNELS) {
      expect(typeof channel.icon).toBe('string');
      expect(typeof channel.sortOrder).toBe('number');
    }
  });

  it('exposes badges publicly but never the provider', () => {
    const qris = toPublicChannel(descriptor('QRIS'));
    expect(qris).toMatchObject({ code: 'QRIS', icon: 'qris', popular: true, instant: true });
    expect(qris).not.toHaveProperty('provider');
    expect(toPublicChannel(descriptor('MANUAL_TRANSFER'))).toMatchObject({ recommended: true });
  });

  it('groups cover exactly the four checkout sections', () => {
    expect(new Set(PAYMENT_CHANNELS.map((c) => c.group))).toEqual(
      new Set(['MANUAL', 'QR', 'EWALLET', 'VIRTUAL_ACCOUNT', 'CARD']),
    );
  });
});

// ---------------------------------------------------------------------------
// Checkout flow integration: gateway charge runs AFTER commit, manual untouched.
// ---------------------------------------------------------------------------
import { OrdersService } from '../../src/modules/orders/orders.service';
import { MERCHANT_FEE_FIELDS } from '../../src/modules/orders/domain/customer-order-view';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { PaymentChannelRegistry } from '../../src/modules/payments/gateway/payment-channel.registry';
import { PaymentProviderFactory } from '../../src/modules/payments/gateway/payment-provider.factory';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: { id: 'pay-1', amount: 30000 } };

function checkoutDto(over: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 1 }], ...over };
}

function checkoutPrisma() {
  const tx = {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(CREATED_ORDER) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'addr-1', userId: USER, deletedAt: null, provinceId: 'p', cityId: 'c',
        districtId: 'd', villageId: 'v', postalCode: '40131', latitude: -6.9, longitude: 107.6,
      }),
    },
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'o1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 }) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function checkoutService(initiate?: jest.Mock, feeEnabled = true) {
  const prisma = checkoutPrisma();
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/raw' }) };
  const midtransStub = { name: 'midtrans', supportedChannels: () => ['QRIS' as const] };
  // Manual transfer is always registered in the app; P0-3 makes a BANK_TRANSFER
  // checkout require it to be READY (an active bank account) - here it is.
  const manualStub = { name: 'manual', supportedChannels: () => ['MANUAL_TRANSFER' as const], isReady: async () => true };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = new PaymentChannelRegistry(new PaymentProviderFactory([manualStub as any, midtransStub as any]));
  const initiation = initiate ? { initiate } : undefined;
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any,
    undefined, undefined, undefined, undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initiation as any, initiate ? registry : undefined,
    { enabled: feeEnabled }, // PAYMENT_SERVICE_FEE_ENABLED
  );
  return { service, prisma, initiate };
}

describe('checkout → gateway integration', () => {
  const chargeOk = () =>
    jest.fn().mockResolvedValue(charge({ instructions: { kind: 'QR', amount: 30000, qrString: 'QR-DATA', howTo: [] } }));

  it('GATEWAY: charges after commit and appends the additive block to the order', async () => {
    const initiate = chargeOk();
    const { service, prisma } = checkoutService(initiate);

    const outcome = await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'QRIS' }));
    const body = (outcome as { body: Record<string, unknown> }).body;

    // Charge happened AFTER the transaction committed (never inside it).
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(initiate.mock.invocationCallOrder[0]);
    expect(initiate).toHaveBeenCalledWith('pay-1', 'QRIS');
    // Existing order fields untouched…
    expect(body).toMatchObject({ id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000 });
    // …plus the additive gateway block.
    expect(body).toMatchObject({
      paymentMethod: PaymentMethod.GATEWAY, paymentChannel: 'QRIS', provider: 'midtrans', qrString: 'QR-DATA',
    });
    expect((body.paymentInstruction as { type: string }).type).toBe('QR');
  });

  it('A. fee ENABLED: persists the full breakdown and the customer total includes the fee', async () => {
    const initiate = chargeOk();
    const { service, prisma } = checkoutService(initiate, true);

    await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'BNI_VA' }));

    const data = prisma.__tx.order.create.mock.calls[0][0].data;
    // Product (20,000) + shipping (10,000) is the fee base: no tax is added.
    expect(data).toMatchObject({
      paymentServiceFee: 4_000, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 0,
      paymentServiceFeeEnabled: true, paymentServiceFeeChannel: 'BNI_VA', totalPrice: 34_000,
    });
    expect(data.paymentServiceFeeRule).toMatchObject({ channel: 'BNI_VA', type: 'FIXED', fixedAmount: 4_000, passThrough: 'ALLOWED' });
    expect(data.payment.create.amount).toBe(34_000);
    // Shipping is stored unchanged and is not conflated with the payment fee.
    expect(data.shipment.create.cost).toBe(10_000);
  });

  it('B/D. fee DISABLED: customer total excludes the fee, the merchant cost is still recorded', async () => {
    const initiate = chargeOk();
    const { service, prisma } = checkoutService(initiate, false);

    await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'BNI_VA' }));

    const data = prisma.__tx.order.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      paymentServiceFee: 0, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 4_000,
      paymentServiceFeeEnabled: false, paymentServiceFeeChannel: 'BNI_VA', totalPrice: 30_000,
    });
    expect(data.payment.create.amount).toBe(30_000);
  });

  it('C. summary per channel in both modes; QRIS and cards never pass the fee on', async () => {
    const channels = ['QRIS', 'GOPAY', 'BNI_VA', 'BCA_VA', 'SHOPEEPAY', 'CREDIT_CARD'];
    const on = checkoutService(undefined, true).service;
    const off = checkoutService(undefined, false).service;
    const enabled = await Promise.all(channels.map((c) => on.getSummary(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: c }))));
    const disabled = await Promise.all(channels.map((c) => off.getSummary(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: c }))));

    //                                            QRIS  GOPAY  BNI_VA  BCA_VA  SHOPEEPAY  CARD
    expect(enabled.map((s) => s.payment_service_fee)).toEqual([0, 600, 4_000, 4_000, 600, 0]);
    expect(enabled.map((s) => s.grand_total)).toEqual([30_000, 30_600, 34_000, 34_000, 30_600, 30_000]);
    expect(disabled.map((s) => s.payment_service_fee)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(disabled.map((s) => s.grand_total)).toEqual([30_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    // The "Biaya Layanan" row applies to every gateway summary, Rp0 included.
    expect([...enabled, ...disabled].every((s) => s.payment_service_fee_applies === true)).toBe(true);
  });

  it('the customer-facing summary never exposes the merchant-absorbed fee or the rule', async () => {
    const summary = await checkoutService(undefined, false).service.getSummary(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'BNI_VA' }));
    expect(summary).not.toHaveProperty('payment_service_fee_breakdown');
    expect(JSON.stringify(summary)).not.toMatch(/absorbed|Absorbed|calculatedFee|passThrough/);
  });

  it('the checkout response carries the customer fee but never the merchant fee accounting', async () => {
    const { service, prisma } = checkoutService(chargeOk(), false);
    // The persisted row carries the full breakdown (as the real create would return it).
    prisma.__tx.order.create.mockResolvedValue({
      ...CREATED_ORDER, paymentServiceFee: 0, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 4_000,
      paymentServiceFeeEnabled: false, paymentServiceFeeChannel: 'BNI_VA', paymentServiceFeeRule: { channel: 'BNI_VA' },
    });

    const outcome = await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'BNI_VA' }));
    const body = (outcome as { body: Record<string, unknown> }).body;

    expect(body).toMatchObject({ id: 'order-1', paymentServiceFee: 0, totalPrice: 30000 });
    for (const field of MERCHANT_FEE_FIELDS) expect(body).not.toHaveProperty(field);
  });

  it('the customer order list never carries the merchant fee accounting', async () => {
    const { service, prisma } = checkoutService();
    Object.assign(prisma.order, {
      findMany: jest.fn().mockResolvedValue([
        { id: 'o1', paymentServiceFee: 0, paymentServiceFeeCalculated: 4_000, paymentServiceFeeAbsorbed: 4_000, paymentServiceFeeRule: {}, payment: null },
        { id: 'o2', paymentServiceFee: 800, paymentServiceFeeCalculated: 800, paymentServiceFeeAbsorbed: 0, payment: { id: 'p', gatewayTransactions: [] } },
      ]),
    });

    const orders = (await service.listForUser(USER)) as Array<Record<string, unknown>>;

    expect(orders.map((o) => o.paymentServiceFee)).toEqual([0, 800]);
    for (const order of orders) for (const field of MERCHANT_FEE_FIELDS) expect(order).not.toHaveProperty(field);
  });

  it('I. manual transfer: no gateway fee, no "Biaya Layanan" row, totals unchanged', async () => {
    const summary = await checkoutService(undefined, true).service.getSummary(USER, checkoutDto({ payment_method: PaymentMethod.BANK_TRANSFER }));
    expect(summary).toMatchObject({ subtotal: 20_000, shipping_cost: 10_000, discount: 0, payment_service_fee: 0, payment_service_fee_applies: false, grand_total: 30_000 });
  });

  it('H. deducts an existing voucher discount before calculating the fee base', async () => {
    const { service, prisma } = checkoutService();
    prisma.promo.findFirst.mockResolvedValue({
      id: 'promo-1', code: 'SAVE5K', isActive: true, startDate: null, endDate: null,
      maxUsageCount: null, currentUsageCount: 0, minimumOrderAmount: 0, isNewUserOnly: false,
      voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 5_000, discountPercentage: null,
      maxDiscountAmount: null, freeShippingMaxAmount: null,
    });

    const summary = await service.getSummary(USER, checkoutDto({
      voucher_code: 'save5k', payment_method: PaymentMethod.GATEWAY, payment_channel: 'GOPAY',
    }));

    // Subtotal, shipping and the voucher are unchanged by the fee; the fee is on
    // (20,000 subtotal + 10,000 shipping - 5,000 voucher) × 2% = 500.
    expect(summary).toMatchObject({ subtotal: 20_000, shipping_cost: 10_000, discount: 5_000, payment_service_fee: 500, grand_total: 25_500 });
  });

  it('BANK_TRANSFER: byte-compatible — no gateway call, no extra fields', async () => {
    const initiate = chargeOk();
    const { service } = checkoutService(initiate);

    const outcome = await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.BANK_TRANSFER }));
    const body = (outcome as { body: Record<string, unknown> }).body;

    expect(initiate).not.toHaveBeenCalled();
    expect(body).toStrictEqual(CREATED_ORDER); // exactly what the transaction returned: no extra fields
    expect(body).not.toHaveProperty('paymentInstruction');
  });

  it('a gateway order without a channel skips initiation (order still created)', async () => {
    const noChannel = checkoutService(chargeOk());
    await noChannel.service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY }));
    expect(noChannel.initiate).not.toHaveBeenCalled();
  });

  // Phase 4A: COD is rejected by the registry-derived guard before anything runs.
  it('COD is rejected — no order, no charge', async () => {
    const cod = checkoutService(chargeOk());
    await expect(cod.service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.COD }))).rejects.toThrow(
      /no longer available/,
    );
    expect(cod.initiate).not.toHaveBeenCalled();
  });

  it('a gateway outage NEVER loses the order — it returns unchanged with PENDING payment', async () => {
    const initiate = jest.fn().mockRejectedValue(new Error('midtrans 503'));
    const { service } = checkoutService(initiate);

    const outcome = await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'QRIS' }));
    const body = (outcome as { body: Record<string, unknown> }).body;

    expect(initiate).toHaveBeenCalled();
    expect(body).toStrictEqual(CREATED_ORDER); // order stands
    expect(body).not.toHaveProperty('paymentInstruction');
  });

  it('with the gateway module absent, checkout behaves exactly as before', async () => {
    const { service } = checkoutService(); // no initiation service injected
    const outcome = await service.checkout(USER, checkoutDto({ payment_method: PaymentMethod.GATEWAY, payment_channel: 'QRIS' }));
    expect((outcome as { body: unknown }).body).toStrictEqual(CREATED_ORDER);
  });
});

// ---------------------------------------------------------------------------
// Phase 4A — COD removal. Proves COD is unselectable while history stays intact.
// ---------------------------------------------------------------------------
import {
  DEFAULT_PAYMENT_METHOD,
  isSelectablePaymentMethod,
  selectablePaymentMethods,
} from '../../src/modules/payments/gateway/domain/payment-channel';

describe('Phase 4A — COD is not a selectable payment method', () => {
  it('COD appears in NO channel of the catalog', () => {
    // Widened to string on purpose: PaymentChannelCode has no 'COD' member at all,
    // so the type system already makes a COD channel unrepresentable.
    const codes: string[] = PAYMENT_CHANNELS.map((c) => c.code);
    expect(codes).not.toContain('COD');
    const methods: string[] = PAYMENT_CHANNELS.map((c) => c.method);
    expect(methods).not.toContain(PaymentMethod.COD);
  });

  it('GET /payments/channels output can never contain COD', () => {
    const publicView = JSON.stringify(PAYMENT_CHANNELS.map(toPublicChannel));
    expect(publicView).not.toContain('COD');
  });

  it('the registry-derived selectable set excludes COD', () => {
    expect(isSelectablePaymentMethod(PaymentMethod.COD)).toBe(false);
    expect(selectablePaymentMethods()).not.toContain(PaymentMethod.COD);
  });

  it('the omitted-method default is manual transfer, never COD', () => {
    expect(DEFAULT_PAYMENT_METHOD).toBe(PaymentMethod.BANK_TRANSFER);
    expect(isSelectablePaymentMethod(DEFAULT_PAYMENT_METHOD)).toBe(true);
  });

  it('every other existing method remains selectable (nothing else regressed)', () => {
    expect(isSelectablePaymentMethod(PaymentMethod.BANK_TRANSFER)).toBe(true);
    expect(isSelectablePaymentMethod(PaymentMethod.GATEWAY)).toBe(true);
    expect(isSelectablePaymentMethod(PaymentMethod.QRIS)).toBe(true); // legacy manual QRIS
  });

  it('the nine Midtrans channels are untouched by the removal', () => {
    expect(PAYMENT_CHANNELS.filter((c) => c.method === PaymentMethod.GATEWAY).map((c) => c.code)).toEqual([
      'QRIS', 'GOPAY', 'SHOPEEPAY', 'BCA_VA', 'BNI_VA', 'BRI_VA', 'MANDIRI_BILL', 'PERMATA_VA', 'CREDIT_CARD',
    ]);
  });

  it('historical COD data stays readable — the enum value still exists', () => {
    // Deleting the enum value would break every historical COD order/payment row.
    expect(PaymentMethod.COD).toBe('COD');
  });
});
