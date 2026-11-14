import { OrdersService } from '../../src/modules/orders/orders.service';
import { PaymentMethod, VoucherType } from '@prisma/client';

describe('OrdersService voucher discount persistence (Phase 4C/4G.1)', () => {
  let service: OrdersService;
  let prisma: any;
  let capturedTx: any;
  let uploadTokens: any;

  const makeTx = () => ({
    product: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
    order: {
      create: jest.fn().mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', payment: { id: 'pay1' } }),
    },
    voucherUsage: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    promo: { update: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  });

  beforeEach(() => {
    capturedTx = null;
    prisma = {
      $transaction: jest.fn(async (fn: any) => {
        capturedTx = makeTx();
        return fn(capturedTx);
      }),
    };
    uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: null }) };
    service = new OrdersService(prisma, {} as any, {} as any, uploadTokens as any);
  });

  const base = (overrides: Record<string, any> = {}) => ({
    subtotal: 100000,
    shipping_cost: 10000,
    discount: 0,
    productDiscountAmount: 0,
    shippingDiscountAmount: 0,
    payment_service_fee: 0,
    payment_service_fee_breakdown: null,
    grand_total: 110000,
    shipping: { provider: 'jne', service: 'REG', serviceName: 'JNE REG', shippingCost: 10000 },
    voucher: null,
    ...overrides,
  });

  const callPersist = (orderNumber: string, summary: any, dtoOverrides: Record<string, any> = {}) => {
    const items = [{ productId: 'p1', quantity: 1, toppingIds: [] }];
    const products: any = [{ id: 'p1', name: 'Product', price: 100000, stock: 10, weightGram: 1000 }];
    const toppings: any = [];
    const dto: any = { address_id: 'addr1', courier: 'jne', items: [{ product_id: 'p1', qty: 1 }], ...dtoOverrides };
    return (service as any).persistOrderOnce(orderNumber, {
      userId: 'user1',
      dto,
      items,
      products,
      toppings,
      summary,
      idempotencyRecordId: null,
      fenceToken: null,
    });
  };

  const orderData = () => capturedTx.order.create.mock.calls[0][0].data;

  it('persists product-only component discount', async () => {
    const summary = base({
      discount: 15000,
      productDiscountAmount: 15000,
      shippingDiscountAmount: 0,
      grand_total: 95000,
      voucher: { id: 'v1', code: 'PROMO', voucherType: VoucherType.PERCENTAGE_DISCOUNT },
    });
    await callPersist('ORD-1', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(15000);
    expect(data.shippingDiscountAmount).toBe(0);
    expect(data.voucherDiscountAmount).toBe(15000);
    expect(data.voucherDiscountAmount).toBe(data.productDiscountAmount + data.shippingDiscountAmount);
  });

  it('persists shipping-only component discount', async () => {
    const summary = base({
      discount: 10000,
      productDiscountAmount: 0,
      shippingDiscountAmount: 10000,
      grand_total: 100000,
      voucher: { id: 'v1', code: 'SHIP', voucherType: VoucherType.FREE_SHIPPING },
    });
    await callPersist('ORD-2', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(0);
    expect(data.shippingDiscountAmount).toBe(10000);
    expect(data.voucherDiscountAmount).toBe(10000);
    expect(data.voucherDiscountAmount).toBe(data.productDiscountAmount + data.shippingDiscountAmount);
  });

  it('persists combined product and shipping discount', async () => {
    const summary = base({
      discount: 15000,
      productDiscountAmount: 10000,
      shippingDiscountAmount: 5000,
      grand_total: 95000,
      voucher: { id: 'v1', code: 'COMBO', voucherType: VoucherType.PERCENTAGE_DISCOUNT },
    });
    await callPersist('ORD-3', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(10000);
    expect(data.shippingDiscountAmount).toBe(5000);
    expect(data.voucherDiscountAmount).toBe(15000);
    expect(data.voucherDiscountAmount).toBe(data.productDiscountAmount + data.shippingDiscountAmount);
  });

  it('persists legacy percentage voucher as product breakdown', async () => {
    const summary = base({
      discount: 10000,
      productDiscountAmount: 10000,
      shippingDiscountAmount: 0,
      grand_total: 100000,
      voucher: { id: 'v1', code: 'LEG10', voucherType: VoucherType.PERCENTAGE_DISCOUNT },
    });
    await callPersist('ORD-4', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(10000);
    expect(data.shippingDiscountAmount).toBe(0);
    expect(data.voucherDiscountAmount).toBe(10000);
  });

  it('persists legacy fixed voucher as product breakdown', async () => {
    const summary = base({
      discount: 5000,
      productDiscountAmount: 5000,
      shippingDiscountAmount: 0,
      grand_total: 105000,
      voucher: { id: 'v1', code: 'FIX5', voucherType: VoucherType.FIXED_DISCOUNT },
    });
    await callPersist('ORD-5', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(5000);
    expect(data.shippingDiscountAmount).toBe(0);
    expect(data.voucherDiscountAmount).toBe(5000);
  });

  it('persists legacy FREE_SHIPPING as shipping breakdown', async () => {
    const summary = base({
      discount: 10000,
      productDiscountAmount: 0,
      shippingDiscountAmount: 10000,
      grand_total: 100000,
      voucher: { id: 'v1', code: 'FREESHIP', voucherType: VoucherType.FREE_SHIPPING },
    });
    await callPersist('ORD-6', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(0);
    expect(data.shippingDiscountAmount).toBe(10000);
    expect(data.voucherDiscountAmount).toBe(10000);
  });

  it('persists zero discounts when no voucher applied', async () => {
    const summary = base();
    await callPersist('ORD-7', summary);
    const data = orderData();
    expect(data.productDiscountAmount).toBe(0);
    expect(data.shippingDiscountAmount).toBe(0);
    expect(data.voucherDiscountAmount).toBe(0);
  });

  it('keeps Order.totalPrice unchanged and does not double-discount', async () => {
    const summary = base({
      discount: 15000,
      productDiscountAmount: 10000,
      shippingDiscountAmount: 5000,
      grand_total: 95000,
      voucher: { id: 'v1', code: 'COMBO', voucherType: VoucherType.PERCENTAGE_DISCOUNT },
    });
    await callPersist('ORD-8', summary);
    const data = orderData();
    expect(data.totalPrice).toBe(95000);
    expect(data.voucherDiscountAmount).toBe(15000);
    // persisted totals come from summary authoritative values; breakdown is additive metadata
    expect(data.totalPrice).not.toBe(summary.subtotal + summary.shipping_cost - data.productDiscountAmount - data.shippingDiscountAmount - data.voucherDiscountAmount);
  });

  it('persists breakdown in same transaction, with integer non-negative values, and preserves payment/unique-code behavior', async () => {
    const summary = base({
      discount: 5000,
      productDiscountAmount: 5000,
      shippingDiscountAmount: 0,
      grand_total: 105000,
      voucher: { id: 'v1', code: 'FIX', voucherType: VoucherType.FIXED_DISCOUNT },
    });
    await callPersist('ORD-9', summary);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(capturedTx).toBeTruthy();
    expect(capturedTx.order.create).toHaveBeenCalledTimes(1);
    // outbox emitted in same transaction (current impl) — mock proves tx shape compatibility
    expect(capturedTx.outboxEvent.create).toHaveBeenCalledTimes(1);

    const data = orderData();
    for (const field of ['productDiscountAmount', 'shippingDiscountAmount', 'voucherDiscountAmount', 'totalPrice'] as const) {
      expect(Number.isInteger(data[field])).toBe(true);
      expect(data[field]).toBeGreaterThanOrEqual(0);
    }
    expect(data.voucherDiscountAmount).toBe(data.productDiscountAmount + data.shippingDiscountAmount);

    // Payment/unique-code behavior (test seam: no uniqueCode service wired, BANK_TRANSFER default)
    // Payment is nested in order.create; transfer total equals charged total when uniqueCode not allocated.
    const paymentCreate = data.payment?.create;
    expect(paymentCreate).toBeTruthy();
    expect(paymentCreate.amount).toBe(summary.grand_total);
    expect(paymentCreate.uniqueCode).toBeNull();
    expect(paymentCreate.method).toBe(PaymentMethod.BANK_TRANSFER);
    expect(paymentCreate.status).toBe('PENDING');

    // S1: checkout no longer mints an upload token (the notification sender does).
    expect(uploadTokens.issue).not.toHaveBeenCalled();
  });
});
