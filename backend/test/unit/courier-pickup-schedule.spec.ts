import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * The approved pickup policy reaches BOTH couriers through the real booking path.
 *
 * ShipmentService is built with the REAL PaxelPickupScheduler (automatic Paxel
 * booking ON, the business default policy) and stub couriers declared exactly as in
 * production: Paxel requires a pickup schedule and is SENT `pickupAtIso`; JNE books
 * automatically and is sent the RECORDED slot as `recordedPickupAtIso`.
 *
 * The courier call still happens immediately - the pickup is in the future, the
 * booking is not deferred.
 */

const MON_17_WIB = '2026-11-09T10:00:00.000Z';
const FRI_17_WIB = '2026-11-06T10:00:00.000Z';
const WED_17_WIB = '2026-11-04T10:00:00.000Z';

const CONFIG = {
  paxel: { autoPickup: { enabled: true, ...DEFAULT_PICKUP_POLICY } },
  pickupPolicy: DEFAULT_PICKUP_POLICY,
} as unknown as ShippingConfig;

type Courier = 'paxel' | 'jne';

function order(courier: Courier, verifiedAt: Date | null, shipmentMetadata: unknown = null) {
  return {
    id: 'o1',
    orderNumber: 'BMS-1',
    subtotal: 135000,
    totalPrice: 150000,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: courier,
    shippingService: courier === 'paxel' ? 'PAXEL_REGULAR' : 'REG',
    shippingServiceName: courier === 'paxel' ? 'Paxel Regular' : 'JNE Reguler',
    payment: verifiedAt ? { verifiedAt } : null,
    shipment: {
      id: 'sh1',
      provider: courier,
      service: courier === 'paxel' ? 'PAXEL_REGULAR' : 'REG',
      status: ShipmentStatus.RATE_SELECTED,
      trackingNumber: null,
      metadata: shipmentMetadata,
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
      {
        quantity: 1,
        productName: 'Bakso',
        unitPrice: 45000,
        weightGram: 450,
        lengthCm: 20,
        widthCm: 15,
        heightCm: 10,
        isFragile: false,
        product: { sku: 'SKU-1', name: 'Bakso', category: { name: 'Makanan' } },
      },
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
  const created = {
    trackingNumber: 'AWB-1',
    providerShipmentId: 'AWB-1',
    status: ShipmentStatus.CREATED,
    rawPayload: {},
  };
  const provider =
    theOrder.shippingProvider === 'paxel'
      ? { name: 'paxel', requiresPickupSchedule: true, createShipment: jest.fn().mockResolvedValue(created) }
      : { name: 'jne', supportsAutomaticBooking: true, createShipment: jest.fn().mockResolvedValue(created) };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, factory as any, undefined, new PaxelPickupScheduler(CONFIG));
  return { service, prisma, provider };
}

/** The pickup field each courier is actually sent. */
const sentSlot = (courier: Courier, provider: { createShipment: jest.Mock }) => {
  const input = provider.createShipment.mock.calls[0][0];
  return courier === 'paxel' ? input.pickupAtIso : input.recordedPickupAtIso;
};

describe.each<Courier>(['paxel', 'jne'])('%s booking uses the shared pickup policy', (courier) => {
  it.each([
    ['Tuesday 14:59 WIB -> Tuesday', '2026-11-03T14:59:00+07:00', '2026-11-03T10:00:00.000Z'],
    ['Tuesday 15:00 WIB (the cut-off) -> Wednesday', '2026-11-03T15:00:00+07:00', WED_17_WIB],
    ['Friday 14:59 WIB -> Friday', '2026-11-06T14:59:00+07:00', FRI_17_WIB],
    ['Friday 15:00 WIB -> Monday', '2026-11-06T15:00:00+07:00', MON_17_WIB],
    ['Saturday 09:00 WIB -> Monday', '2026-11-07T09:00:00+07:00', MON_17_WIB],
    ['Sunday 23:59 WIB -> Monday', '2026-11-08T23:59:00+07:00', MON_17_WIB],
  ])('%s at 17:00, booked immediately', async (_label, verifiedAt, expected) => {
    const { service, provider } = build(order(courier, new Date(verifiedAt)));
    const outcome = await service.createForOrder('o1');
    expect(outcome.ok).toBe(true);
    // Immediate: the courier is called now, with a FUTURE pickup appointment.
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
    expect(sentSlot(courier, provider)).toBe(expected);
  });

  it('persists the slot before booking', async () => {
    const { service, prisma } = build(order(courier, new Date('2026-11-06T15:00:00+07:00')));
    await service.createForOrder('o1');
    const write = prisma.shipment.update.mock.calls.find(
      ([arg]: [{ data?: { metadata?: unknown } }]) => arg?.data?.metadata !== undefined,
    );
    expect(JSON.stringify(write?.[0].data.metadata)).toContain(MON_17_WIB);
  });

  it('a retry keeps an already persisted slot instead of recomputing it under the new rule', async () => {
    // A historical slot (a Saturday, under the old rule) stays exactly as booked.
    const historical = '2026-09-05T10:00:00.000Z';
    const metadata = { [courier]: { pickupDatetime: historical } };
    const { service, provider, prisma } = build(order(courier, new Date('2026-11-06T15:00:00+07:00'), metadata));
    await service.createForOrder('o1');
    expect(sentSlot(courier, provider)).toBe(historical);
    const rewrite = prisma.shipment.update.mock.calls.find(
      ([arg]: [{ data?: { metadata?: unknown } }]) => JSON.stringify(arg?.data?.metadata ?? '').includes(MON_17_WIB),
    );
    expect(rewrite).toBeUndefined();
  });
});
