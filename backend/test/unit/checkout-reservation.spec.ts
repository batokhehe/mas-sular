import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Bakso', price: 20000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 250 };
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: {} };

function dto(over: Partial<CreateOrderDto> = {}): CreateOrderDto {
  return { address_id: 'addr-1', courier: CheckoutCourier.JNE, items: [{ product_id: 'p1', qty: 2 }], ...over };
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
    $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

type InventoryMock = { reserveForOrder: jest.Mock; availableByProduct?: jest.Mock };

/** Stok Produk availability as InventoryReservationService.availableByProduct reports it. */
const stokProduk = (available: Record<string, number>) =>
  jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, available[id] ?? 0])));

function build(inventory: InventoryMock, product: Record<string, unknown> = PRODUCT) {
  inventory.availableByProduct ??= stokProduk({ p1: 10 });
  const prisma = buildPrisma();
  prisma.product.findMany = jest.fn().mockResolvedValue([product]);
  const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) };
  const idempotency = { isCheckoutEnabled: jest.fn().mockReturnValue(false) };
  const uploadTokens = { issue: jest.fn().mockResolvedValue({ uploadUrl: 'https://app/u/x', expiresAt: new Date() }) };
  const service = new OrdersService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma as any, shipping as any, idempotency as any, uploadTokens as any, undefined, inventory as any,
  );
  return { service, prisma };
}

describe('Checkout — inventory reservation path', () => {
  it('reserves stock (does NOT decrement Product.stock) when inventory is wired', async () => {
    const inventory = { reserveForOrder: jest.fn().mockResolvedValue(undefined) };
    const { service, prisma } = build(inventory);

    await service.checkout(USER, dto());

    expect(inventory.reserveForOrder).toHaveBeenCalledWith(
      prisma.__tx,
      expect.objectContaining({ orderId: 'order-1', items: [{ productId: 'p1', quantity: 2 }] }),
    );
    // Reservation path: no immediate stock decrement.
    expect(prisma.__tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back the whole checkout when a reservation fails', async () => {
    const inventory = { reserveForOrder: jest.fn().mockRejectedValue(new Error('Insufficient available stock')) };
    const { service } = build(inventory);

    await expect(service.checkout(USER, dto())).rejects.toThrow('Insufficient available stock');
  });

  it('accepts a quantity covered by Stok Produk even when the master Product.stock is 0', async () => {
    const inventory = { reserveForOrder: jest.fn().mockResolvedValue(undefined), availableByProduct: stokProduk({ p1: 5 }) };
    const { service } = build(inventory, { ...PRODUCT, stock: 0 });

    await service.checkout(USER, dto({ items: [{ product_id: 'p1', qty: 5 }] }));

    expect(inventory.availableByProduct).toHaveBeenCalledWith(['p1']);
    expect(inventory.reserveForOrder).toHaveBeenCalled();
  });

  it('rejects when Stok Produk is 0 even though the master Product.stock is positive', async () => {
    const inventory = { reserveForOrder: jest.fn(), availableByProduct: stokProduk({ p1: 0 }) };
    const { service, prisma } = build(inventory, { ...PRODUCT, stock: 50 });

    await expect(service.checkout(USER, dto())).rejects.toThrow('Insufficient stock for Bakso');
    expect(inventory.reserveForOrder).not.toHaveBeenCalled();
    expect(prisma.__tx.order.create).not.toHaveBeenCalled();
  });

  it('rejects a cart quantity above the Stok Produk availability (lines of the same product are summed)', async () => {
    const inventory = { reserveForOrder: jest.fn(), availableByProduct: stokProduk({ p1: 3 }) };
    const { service } = build(inventory, { ...PRODUCT, stock: 100 });

    await expect(
      service.checkout(USER, dto({ items: [{ product_id: 'p1', qty: 2 }, { product_id: 'p1', qty: 2 }] })),
    ).rejects.toThrow('Insufficient stock for Bakso');
    expect(inventory.reserveForOrder).not.toHaveBeenCalled();
  });
});
