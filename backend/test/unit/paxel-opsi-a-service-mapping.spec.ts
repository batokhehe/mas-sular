import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * Paxel create Opsi A — the service half.
 *
 * ShipmentService.createForOrder is what feeds PaxelShipmentProvider, so this pins
 * the two inputs Opsi A needs from it: every order line's `productId` (the grouping
 * key) and `goodsAmount` = Order.subtotal (the aggregate `price`). The courier is a
 * stub that captures its input; no HTTP is involved.
 *
 * JNE receives the same item list. The extra `productId` is ignored by its mapping;
 * the JNE wire format itself is pinned by the JNE suites.
 */

const CONFIG = {
  paxel: { autoPickup: { enabled: true, ...DEFAULT_PICKUP_POLICY } },
  pickupPolicy: DEFAULT_PICKUP_POLICY,
} as unknown as ShippingConfig;

type Courier = 'paxel' | 'jne';

const line = (productId: string, sku: string | null, name: string, quantity: number, weightGram: number | null) => ({
  productId,
  quantity,
  productName: name,
  unitPrice: 45000,
  weightGram,
  lengthCm: 20,
  widthCm: 15,
  heightCm: 10,
  isFragile: false,
  product: { sku, name, category: { name: 'Makanan' } },
});

function order(courier: Courier) {
  return {
    id: 'o1',
    orderNumber: 'BMS-1',
    subtotal: 158000,
    totalPrice: 183000,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: courier,
    shippingService: courier === 'paxel' ? 'PAXEL_REGULAR' : 'REG',
    shippingServiceName: courier === 'paxel' ? 'Paxel Regular' : 'JNE Reguler',
    payment: { verifiedAt: new Date('2026-11-03T14:00:00+07:00') },
    // A recorded slot for both couriers, so no scheduling write is needed.
    shipment: {
      id: 'sh1',
      provider: courier,
      service: courier === 'paxel' ? 'PAXEL_REGULAR' : 'REG',
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: {
        paxel: { pickupDatetime: '2026-11-03T10:00:00.000Z' },
        jne: { pickupDatetime: '2026-11-03T10:00:00.000Z' },
      },
    },
    address: {
      recipientName: 'Budi',
      phone: '628123',
      addressDetail: 'Jl. Test 1',
      fullAddress: 'Jl. Test 1',
      postalCode: '40131',
      districtId: 'district-sukajadi',
      notes: null,
      latitude: -6.8,
      longitude: 107.5,
      province: { name: 'Jawa Barat' },
      city: { name: 'Kota Bandung' },
      district: { name: 'Sukajadi' },
      village: { name: 'Pasteur' },
    },
    user: { name: 'Budi', email: 'budi@test.com', phone: null },
    items: [
      line('prod-a', 'SKU-001', 'Bakso Urat', 2, 450),
      line('prod-b', null, 'Frozen Baso', 1, 380),
      line('prod-a', 'SKU-001', 'Bakso Urat', 1, 450),
    ],
  };
}

const OUTLET = {
  id: 'out1',
  name: 'Outlet',
  postalCode: '40286',
  addressDetail: 'Jl. Saturnus Sel. No.3',
  latitude: null,
  longitude: null,
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Buahbatu' },
  village: { name: 'Margasari' },
};

function build(theOrder: ReturnType<typeof order>) {
  const tx = {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(theOrder) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET), findUnique: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ metadata: theOrder.shipment.metadata }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  const created = { trackingNumber: 'AWB-1', providerShipmentId: 'AWB-1', status: ShipmentStatus.CREATED, rawPayload: {} };
  const provider =
    theOrder.shippingProvider === 'paxel'
      ? { name: 'paxel', requiresPickupSchedule: true, createShipment: jest.fn().mockResolvedValue(created) }
      : { name: 'jne', supportsAutomaticBooking: true, createShipment: jest.fn().mockResolvedValue(created) };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, factory as any, undefined, new PaxelPickupScheduler(CONFIG));
  return { service, prisma, provider };
}

describe.each<Courier>(['paxel', 'jne'])('%s: createForOrder passes the Opsi A inputs', (courier) => {
  it('selects OrderItem.productId', async () => {
    const { service, prisma } = build(order(courier));
    await service.createForOrder('o1');
    const query = prisma.order.findUnique.mock.calls[0][0];
    expect(query.include.items.select.productId).toBe(true);
  });

  it('reads order lines in a fixed order (id asc), so a retry sends the same payload and signature', async () => {
    const { service, prisma } = build(order(courier));
    await service.createForOrder('o1');
    const query = prisma.order.findUnique.mock.calls[0][0];
    expect(query.include.items.orderBy).toEqual({ id: 'asc' });
  });

  it('maps every order line with its productId, in order, without grouping', async () => {
    const { service, provider } = build(order(courier));
    await service.createForOrder('o1');
    const input = provider.createShipment.mock.calls[0][0];
    expect(input.items.map((i: { productId: string }) => i.productId)).toEqual(['prod-a', 'prod-b', 'prod-a']);
    // A null SKU stays an empty code: the provider decides, nothing is invented.
    expect(input.items[1].code).toBe('');
  });

  it('passes Order.subtotal as goodsAmount and leaves invoiceValue as Order.totalPrice', async () => {
    const { service, provider } = build(order(courier));
    await service.createForOrder('o1');
    const input = provider.createShipment.mock.calls[0][0];
    expect(input.goodsAmount).toBe(158000);
    expect(input.invoiceValue).toBe(183000);
  });
});
