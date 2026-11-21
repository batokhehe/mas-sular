import { OrdersService } from '../../src/modules/orders/orders.service';
import { CheckoutCourier, CreateOrderDto } from '../../src/modules/orders/application/dto/create-order.dto';
import { buildRecipientSnapshot, RECIPIENT_SNAPSHOT_VERSION } from '../../src/modules/orders/domain/recipient-snapshot';
import { INTERNAL_ORDER_FIELDS, toCustomerOrder } from '../../src/modules/orders/domain/customer-order-view';

/**
 * Order.recipientSnapshot (Print Resi hardening). Checkout copies the recipient it
 * validated - from the SAME Address row it priced shipping for - into the order, in
 * the order-create call inside the checkout transaction. Region NAMES are kept as
 * text; coordinates, label and ids are not. A later edit of the saved Address
 * cannot reach the stored copy. Customer responses keep their previous shape.
 */

function address(over: Record<string, unknown> = {}) {
  return {
    id: 'addr-1', userId: USER, deletedAt: null, label: 'Rumah', isDefault: true,
    recipientName: 'Siti Aminah', phone: '081234567890',
    fullAddress: 'Jl. Melati No. 5, Bojongsoang, Bandung',
    addressDetail: 'Jl. Melati No. 5 RT 02/RW 03',
    notes: 'Pagar hijau',
    provinceId: 'prov-1', cityId: 'city-1', districtId: 'dist-1', villageId: 'vill-1',
    province: { name: 'Jawa Barat' }, city: { name: 'Kabupaten Bandung' },
    district: { name: 'Bojongsoang' }, village: { name: 'Lengkong', rajaOngkirId: null },
    postalCode: '40287', latitude: -6.9, longitude: 107.6,
    ...over,
  };
}

const USER = 'user-1';
const CREATED_ORDER = { id: 'order-1', orderNumber: 'BMS-1', totalPrice: 30000, items: [], payment: {} };

function product(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Bakso',
    price: 20000,
    stock: 10,
    status: 'ACTIVE',
    deletedAt: null,
    weightGram: 450,
    lengthCm: 20,
    widthCm: 15,
    heightCm: 10,
    isFragile: true,
    ...over,
  };
}

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

function build(products: unknown[], liveAddress: Record<string, unknown> = address()) {
  const tx = buildTx();
  const prisma = {
    product: { findMany: jest.fn().mockResolvedValue(products) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    address: {
      findFirst: jest.fn().mockImplementation(async () => liveAddress),
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


const created = (tx: ReturnType<typeof buildTx>) => tx.order.create.mock.calls[0][0].data as Record<string, unknown>;

describe('Checkout — immutable recipient snapshot', () => {
  it('stores the validated recipient, with region names as text, on the created order', async () => {
    const { service, tx } = build([product()]);
    await service.checkout(USER, dto());

    expect(created(tx).recipientSnapshot).toEqual({
      version: RECIPIENT_SNAPSHOT_VERSION,
      recipientName: 'Siti Aminah',
      phone: '081234567890',
      addressDetail: 'Jl. Melati No. 5 RT 02/RW 03',
      fullAddress: 'Jl. Melati No. 5, Bojongsoang, Bandung',
      village: 'Lengkong',
      district: 'Bojongsoang',
      city: 'Kabupaten Bandung',
      province: 'Jawa Barat',
      postalCode: '40287',
      note: 'Pagar hijau',
    });
    // The relation is preserved alongside it.
    expect(created(tx).addressId).toBe('addr-1');
  });

  it('keeps nothing a slip does not need: no coordinates, label, ids or flags', async () => {
    const { service, tx } = build([product()]);
    await service.checkout(USER, dto());
    const snapshot = created(tx).recipientSnapshot as Record<string, unknown>;
    for (const key of ['latitude', 'longitude', 'label', 'id', 'userId', 'provinceId', 'cityId', 'districtId', 'villageId', 'isDefault']) {
      expect(snapshot).not.toHaveProperty(key);
    }
  });

  it('is written by the order-create call INSIDE the checkout transaction (atomic with the order)', async () => {
    const { service, prisma, tx } = build([product()]);
    await service.checkout(USER, dto());
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    expect(created(tx).recipientSnapshot).toBeDefined();
    // Never written outside the transaction (the root client has no order.update/create used).
    expect((prisma.order as Record<string, unknown>).create).toBeUndefined();
    expect((prisma.order as Record<string, unknown>).update).toBeUndefined();
  });

  it('a failed order-create commits no snapshot anywhere (nothing is written separately)', async () => {
    const { service, prisma, tx } = build([product()]);
    tx.order.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.checkout(USER, dto())).rejects.toThrow('db down');
    expect((prisma.order as Record<string, unknown>).update).toBeUndefined();
  });

  it('a later edit of the saved Address cannot reach the stored snapshot (copied, not referenced)', async () => {
    const live = address();
    const { service, tx } = build([product()], live);
    await service.checkout(USER, dto());
    const snapshot = created(tx).recipientSnapshot as Record<string, unknown>;

    // The customer edits their saved address after the order exists.
    live.recipientName = 'Nama Baru';
    live.addressDetail = 'Alamat baru';
    (live.city as { name: string }).name = 'Kota Lain';

    expect(snapshot.recipientName).toBe('Siti Aminah');
    expect(snapshot.addressDetail).toBe('Jl. Melati No. 5 RT 02/RW 03');
    expect(snapshot.city).toBe('Kabupaten Bandung');
  });

  it('legacy free-text address (no hierarchy): nulls, never invented values', () => {
    expect(
      buildRecipientSnapshot({ recipientName: 'Budi', phone: '0812', fullAddress: 'Jl. Lama 1', addressDetail: null, notes: null, postalCode: null }),
    ).toEqual({
      version: 1, recipientName: 'Budi', phone: '0812', addressDetail: null, fullAddress: 'Jl. Lama 1',
      village: null, district: null, city: null, province: null, postalCode: null, note: null,
    });
  });

  it('customer responses keep their previous shape: the snapshot is stripped from summary and order views', async () => {
    const { service } = build([product()]);
    const summary = await service.getSummary(USER, dto());
    expect(summary).not.toHaveProperty('recipient_snapshot');
    expect(INTERNAL_ORDER_FIELDS).toContain('recipientSnapshot');
    const view = toCustomerOrder({ id: 'o1', recipientSnapshot: { version: 1 }, address: { id: 'a' } });
    expect(view).toEqual({ id: 'o1', address: { id: 'a' } });
  });
});
