import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { PaymentMethod } from '@prisma/client';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BN-20260611-12345', totalPrice: 30000, items: [], payment: {} };

function dto(over: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 1 }], ...over };
}

function buildTx() {
  return {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(CREATED_ORDER) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
}

function buildPrisma(tx = buildTx()) {
  return {
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: { findFirst: jest.fn().mockResolvedValue({ id: 'addr-1', userId: USER, deletedAt: null }) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function build(prisma = buildPrisma()) {
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, shipping as any, idempotency as any);
  return { service, prisma };
}

/** Pull the data passed to tx.order.create. */
function orderCreateData(prisma: ReturnType<typeof buildPrisma>) {
  return prisma.__tx.order.create.mock.calls[0][0].data;
}

describe('Checkout — payment method persistence', () => {
  it('defaults to COD on both Order and Payment when omitted', async () => {
    const { service, prisma } = build();
    await service.checkout(USER, dto());
    const data = orderCreateData(prisma);
    expect(data.paymentMethod).toBe(PaymentMethod.COD);
    expect(data.payment.create.method).toBe(PaymentMethod.COD);
  });

  it.each([
    PaymentMethod.COD,
    PaymentMethod.BANK_TRANSFER,
    PaymentMethod.QRIS,
    PaymentMethod.GATEWAY, // future
  ])('persists the selected method (%s) identically to Order.paymentMethod and Payment.method', async (method) => {
    const { service, prisma } = build();
    await service.checkout(USER, dto({ payment_method: method }));
    const data = orderCreateData(prisma);
    expect(data.paymentMethod).toBe(method);
    expect(data.payment.create.method).toBe(method);
    // The two must never diverge.
    expect(data.payment.create.method).toBe(data.paymentMethod);
  });
});
