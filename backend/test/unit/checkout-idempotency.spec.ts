import { OrdersService } from '../../src/modules/orders/orders.service';
import { SupersededError } from '../../src/infrastructure/idempotency/idempotency.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

const USER = 'user-1';
const IDEM = { key: 'key-abc', method: 'POST', endpoint: '/checkout/order' };

const DTO: CreateOrderDto = {
  address_id: 'addr-1',
  courier: CheckoutCourier.JNE,
  items: [{ product_id: 'p1', qty: 1 }],
};

const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BN-20260611-12345', items: [], payment: {} };

function buildTx() {
  return {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(CREATED_ORDER) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
  };
}

function buildPrisma(tx = buildTx()) {
  return {
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: { findFirst: jest.fn().mockResolvedValue({ id: 'addr-1', userId: USER, deletedAt: null }) },
    order: { count: jest.fn().mockResolvedValue(0) },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function buildIdempotency() {
  return {
    isCheckoutEnabled: jest.fn().mockReturnValue(true),
    retryAfterSeconds: jest.fn().mockReturnValue(2),
    begin: jest.fn(),
    finalize: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    resolveAfterSupersession: jest.fn(),
  };
}

const PROCEED = { kind: 'proceed', record: { id: 'rec-1', fenceToken: 1 } };

function build(prisma = buildPrisma(), idempotency = buildIdempotency()) {
  const eventBus = { publish: jest.fn().mockResolvedValue(undefined) };
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new OrdersService(prisma as any, eventBus as any, shipping as any, idempotency as any);
  return { service, prisma, idempotency, eventBus };
}

describe('Checkout idempotency orchestration', () => {
  it('runs the legacy path when no Idempotency-Key is supplied', async () => {
    const { service, prisma, idempotency, eventBus } = build();

    const outcome = await service.checkout(USER, DTO); // no idem

    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: false, body: CREATED_ORDER });
  });

  it('runs the legacy path when the feature flag is disabled', async () => {
    const idempotency = buildIdempotency();
    idempotency.isCheckoutEnabled.mockReturnValue(false);
    const { service, prisma } = build(buildPrisma(), idempotency);

    await service.checkout(USER, DTO, IDEM);

    expect(idempotency.begin).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('fresh key: reserves, creates ONE order, finalizes idempotency in-tx with fenceToken', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    const { service, eventBus } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.order.create).toHaveBeenCalledTimes(1); // exactly one order
    expect(idempotency.finalize).toHaveBeenCalledWith(
      prisma.__tx,
      'rec-1',
      1, // fenceToken
      expect.objectContaining({ statusCode: 201, resourceType: 'Order', resourceId: 'order-1' }),
    );
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: false, body: CREATED_ORDER });
  });

  it('replay: returns the stored response without doing any work or publishing', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
    const { service, eventBus } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: { id: 'order-1' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.order.create).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('processing: returns a processing outcome carrying Retry-After seconds', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue({ kind: 'processing' });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('marks the key FAILED (with fenceToken) and rethrows when checkout work fails', async () => {
    const prisma = buildPrisma();
    prisma.$transaction.mockRejectedValue(new Error('stock conflict'));
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    const { service } = build(prisma, idempotency);

    await expect(service.checkout(USER, DTO, IDEM)).rejects.toThrow('stock conflict');
    expect(idempotency.markFailed).toHaveBeenCalledWith('rec-1', 1, expect.any(Error));
  });

  it('superseded → replay: rolls back, never marks FAILED, returns the winner response', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    idempotency.finalize.mockRejectedValue(new SupersededError('rec-1', 1)); // reclaimed mid-flight
    idempotency.resolveAfterSupersession.mockResolvedValue({ kind: 'replay', statusCode: 201, body: { id: 'order-1' } });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'result', statusCode: 201, replayed: true, body: { id: 'order-1' } });
    expect(idempotency.markFailed).not.toHaveBeenCalled(); // we no longer own the key
  });

  it('superseded → processing: returns 409 outcome, never a raw 500', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin.mockResolvedValue(PROCEED);
    idempotency.finalize.mockRejectedValue(new SupersededError('rec-1', 1));
    idempotency.resolveAfterSupersession.mockResolvedValue({ kind: 'processing' });
    const { service } = build(prisma, idempotency);

    const outcome = await service.checkout(USER, DTO, IDEM);

    expect(outcome).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(idempotency.markFailed).not.toHaveBeenCalled();
  });

  it('concurrency: a second request that resolves to processing creates no order', async () => {
    const prisma = buildPrisma();
    const idempotency = buildIdempotency();
    idempotency.begin
      .mockResolvedValueOnce(PROCEED) // winner
      .mockResolvedValueOnce({ kind: 'processing' }); // concurrent loser
    const { service } = build(prisma, idempotency);

    const first = await service.checkout(USER, DTO, IDEM);
    const second = await service.checkout(USER, DTO, IDEM);

    expect(first.kind).toBe('result');
    expect(second).toEqual({ kind: 'processing', retryAfterSeconds: 2 });
    expect(prisma.__tx.order.create).toHaveBeenCalledTimes(1); // only ONE order across both
  });
});
