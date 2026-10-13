import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

/**
 * P2 #6 — partial checkout: the storefront now sends only the cart lines the
 * customer ticked. The selection is client-side UI state, so the server must keep
 * treating `items` as untrusted input and revalidate every one of them against its
 * own product data. No service code changed for #6; this pins the rules it relies
 * on: only the submitted items are ordered, priced from the DB, and a stale or
 * invalid item fails the whole checkout before anything is written.
 */

const USER = 'user-1';
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 0, items: [], payment: {} };

const product = (id: string, price: number, over: Record<string, unknown> = {}) => ({
  id, name: `Product ${id}`, price, stock: 10, status: 'ACTIVE', deletedAt: null,
  weightGram: 250, lengthCm: null, widthCm: null, heightCm: null, isFragile: false, ...over,
});

function dto(items: CreateOrderDto['items']): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items };
}

function build(catalogue: ReturnType<typeof product>[]) {
  const tx = {
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    order: { create: jest.fn().mockResolvedValue(CREATED_ORDER) },
    promo: { update: jest.fn() },
    voucherUsage: { create: jest.fn() },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    // Mirrors the real query: only ACTIVE, non-deleted products among the ids asked for.
    product: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(catalogue.filter((p) => where.id.in.includes(p.id) && p.deletedAt === null && p.status === 'ACTIVE')),
      ),
    },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'addr-1', userId: USER, deletedAt: null,
        provinceId: 'prov-1', cityId: 'city-1', districtId: 'dist-1', villageId: 'vill-1',
        postalCode: '40131', latitude: -6.9, longitude: 107.6,
      }),
    },
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'outlet-1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 }) },
    order: { count: jest.fn().mockResolvedValue(0), findUnique: jest.fn() },
    voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/x', expiresAt: new Date() }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any,
  );
  return { service, prisma, tx };
}

const orderData = (tx: ReturnType<typeof build>['tx']) => tx.order.create.mock.calls[0][0].data;

describe('Checkout — partial cart (only the selected items are submitted)', () => {
  const CATALOGUE = [product('baso', 45000), product('keju', 40000), product('teh', 8000)];

  it('orders exactly the submitted subset, priced from the database', async () => {
    const { service, prisma, tx } = build(CATALOGUE);
    // The cart holds baso, keju and teh; the customer ticked baso x2 and teh x3.
    await service.checkout(USER, dto([{ product_id: 'baso', qty: 2 }, { product_id: 'teh', qty: 3 }]));

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ['baso', 'teh'] }, deletedAt: null, status: 'ACTIVE' }) }),
    );
    const data = orderData(tx);
    expect(data.items.create.map((i: Record<string, unknown>) => [i.productId, i.quantity, i.unitPrice])).toEqual([
      ['baso', 2, 45000],
      ['teh', 3, 8000],
    ]);
    // Subtotal is the server's own sum - the unselected line (keju) is not in it.
    expect(data.subtotal).toBe(2 * 45000 + 3 * 8000);
  });

  it('rejects an item whose product no longer exists or is inactive (stale cart line)', async () => {
    const { service, tx } = build([product('baso', 45000), product('keju', 40000, { status: 'INACTIVE' })]);
    await expect(
      service.checkout(USER, dto([{ product_id: 'baso', qty: 1 }, { product_id: 'keju', qty: 1 }])),
    ).rejects.toThrow('Some products are unavailable');
    await expect(service.checkout(USER, dto([{ product_id: 'gone', qty: 1 }]))).rejects.toThrow('Some products are unavailable');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects a deleted product', async () => {
    const { service, tx } = build([product('baso', 45000, { deletedAt: new Date() })]);
    await expect(service.checkout(USER, dto([{ product_id: 'baso', qty: 1 }]))).rejects.toThrow('Some products are unavailable');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects a quantity above the current stock', async () => {
    const { service, tx } = build([product('baso', 45000, { stock: 2 })]);
    await expect(service.checkout(USER, dto([{ product_id: 'baso', qty: 3 }]))).rejects.toThrow('Insufficient stock for Product baso');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects an empty selection instead of ordering anything', async () => {
    const { service, tx } = build(CATALOGUE);
    await expect(service.checkout(USER, dto([]))).rejects.toThrow('Cart is empty');
    expect(tx.order.create).not.toHaveBeenCalled();
  });

  describe('request validation (same options as the global ValidationPipe in main.ts)', () => {
    const errorsFor = async (body: unknown) =>
      validate(plainToInstance(CreateOrderDto, body), { whitelist: true, forbidNonWhitelisted: true });
    const base = { address_id: 'addr-1', courier: 'jne' };

    it('refuses a client-supplied unit price or subtotal outright', async () => {
      const withPrice = await errorsFor({ ...base, items: [{ product_id: 'baso', qty: 1, price: 1 }] });
      expect(JSON.stringify(withPrice)).toContain('property price should not exist');
      const withSubtotal = await errorsFor({ ...base, subtotal: 1, items: [{ product_id: 'baso', qty: 1 }] });
      expect(JSON.stringify(withSubtotal)).toContain('property subtotal should not exist');
    });

    it('refuses a zero, negative or fractional quantity', async () => {
      for (const qty of [0, -1, 1.5]) {
        expect((await errorsFor({ ...base, items: [{ product_id: 'baso', qty }] })).length).toBeGreaterThan(0);
      }
      expect(await errorsFor({ ...base, items: [{ product_id: 'baso', qty: 2 }] })).toEqual([]);
    });
  });
});
