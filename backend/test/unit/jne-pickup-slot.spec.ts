import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler';
import { readPickupDatetime } from '../../src/modules/shipment/shipment-metadata';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * P1 #13 — the shop-wide pickup rule (cut-off 15:00 WIB, pickup 17:00 WIB) applied
 * to JNE.
 *
 * JNE's `generatecnote` has no pickup field, so JNE is NOT sent a slot and its
 * booking is NOT gated on one. The same slot Paxel would get is RECORDED on the
 * shipment (`metadata.jne.pickupDatetime`) for operations. These tests pin all
 * three halves: the slot is correct, the payload is unchanged, and the booking
 * proceeds exactly as before whatever happens to the recording.
 *
 * The scheduler is the REAL one, with Paxel's automatic booking switched OFF: the
 * switch decides whether Paxel books on its own, not what the shop's pickup is.
 */

const SAME_DAY_17_WIB = '2026-09-05T10:00:00.000Z';
const NEXT_DAY_17_WIB = '2026-09-06T10:00:00.000Z';

function jneOrder(verifiedAt: Date | null, shipmentMetadata: unknown = null) {
  return {
    id: 'o1',
    orderNumber: 'BMS-JNE-1',
    totalPrice: 150000,
    paymentMethod: 'BANK_TRANSFER',
    shippingProvider: 'jne',
    shippingService: 'REG',
    shippingServiceName: 'JNE Reguler',
    payment: verifiedAt ? { verifiedAt } : null,
    shipment: {
      id: 'sh1',
      provider: 'jne',
      service: 'REG',
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
  name: 'Local Dev Outlet',
  postalCode: '40286',
  addressDetail: 'Jl. Saturnus Sel. No.3',
  latitude: null,
  longitude: null,
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Buahbatu' },
  village: { name: 'Margasari' },
};

/** Paxel auto-booking OFF; the shop-wide policy is the business default. */
const CONFIG = {
  paxel: { autoPickup: { enabled: false, ...DEFAULT_PICKUP_POLICY } },
  pickupPolicy: DEFAULT_PICKUP_POLICY,
} as unknown as ShippingConfig;

function build(theOrder: ReturnType<typeof jneOrder>, over: { recordFails?: boolean } = {}) {
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
      update: over.recordFails
        ? jest.fn().mockRejectedValue(new Error('db blip'))
        : jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  // JNE exactly as declared in production: books automatically, no pickup requirement.
  const provider = {
    name: 'jne',
    supportsAutomaticBooking: true,
    createShipment: jest.fn().mockResolvedValue({
      trackingNumber: 'JNE-CNOTE-1',
      providerShipmentId: 'JNE-CNOTE-1',
      status: ShipmentStatus.CREATED,
      rawPayload: { cnote: { cnote_no: 'JNE-CNOTE-1' } },
    }),
  };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  const scheduler = new PaxelPickupScheduler(CONFIG);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, factory as any, undefined, scheduler);
  return { service, prisma, provider };
}

/** The metadata the JNE path wrote, or undefined when it wrote none. */
function recordedMetadata(prisma: ReturnType<typeof build>['prisma']) {
  const call = prisma.shipment.update.mock.calls.find(
    ([arg]: [{ data?: { metadata?: unknown } }]) => arg?.data?.metadata !== undefined,
  );
  return call?.[0].data.metadata as Record<string, unknown> | undefined;
}

describe('JNE carries the shop-wide pickup slot (P1 #13)', () => {
  it.each([
    ['14:59 WIB, before the cut-off', '2026-09-05T14:59:00+07:00', SAME_DAY_17_WIB],
    ['15:00 WIB, the cut-off minute (included)', '2026-09-05T15:00:00+07:00', SAME_DAY_17_WIB],
    ['15:01 WIB, after the cut-off', '2026-09-05T15:01:00+07:00', NEXT_DAY_17_WIB],
    ['17:00 WIB, the PICKUP time - not the cut-off', '2026-09-05T17:00:00+07:00', NEXT_DAY_17_WIB],
  ])('verified at %s -> records the correct 17:00 WIB slot', async (_label, verifiedAt, expected) => {
    const { service, prisma } = build(jneOrder(new Date(verifiedAt)));

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'JNE-CNOTE-1' });
    expect(readPickupDatetime(recordedMetadata(prisma) as never, 'jne')).toBe(expected);
  });

  it('never sends the slot to JNE - the courier payload is unchanged', async () => {
    const { service, provider } = build(jneOrder(new Date('2026-09-05T14:59:00+07:00')));

    await service.createForOrder('o1');

    expect(provider.createShipment).toHaveBeenCalledTimes(1);
    expect(provider.createShipment.mock.calls[0][0].pickupAtIso).toBeUndefined();
  });

  it("writes JNE's own namespace, never Paxel's", async () => {
    const { service, prisma } = build(jneOrder(new Date('2026-09-05T14:59:00+07:00')));

    await service.createForOrder('o1');

    const metadata = recordedMetadata(prisma)!;
    expect(metadata).toEqual({ jne: { pickupDatetime: SAME_DAY_17_WIB } });
    expect(readPickupDatetime(metadata as never, 'paxel')).toBeUndefined();
  });

  it('merges into existing metadata, so earlier failure diagnostics survive', async () => {
    const existing = { error: 'previous attempt timed out', failedAt: '2026-09-05T07:00:00.000Z' };
    const { service, prisma } = build(jneOrder(new Date('2026-09-05T14:59:00+07:00'), existing));

    await service.createForOrder('o1');

    expect(recordedMetadata(prisma)).toEqual({ ...existing, jne: { pickupDatetime: SAME_DAY_17_WIB } });
  });

  it('keeps an already-recorded slot instead of recomputing it', async () => {
    const recorded = { jne: { pickupDatetime: '2026-09-04T10:00:00.000Z' } };
    const { service, prisma, provider } = build(jneOrder(new Date('2026-09-05T15:01:00+07:00'), recorded));

    await service.createForOrder('o1');

    expect(recordedMetadata(prisma)).toBeUndefined();
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
  });
});

describe('the JNE slot never gates or fails the JNE booking', () => {
  it('books normally when there is no verification time to schedule from', async () => {
    const { service, prisma, provider } = build(jneOrder(null));

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'JNE-CNOTE-1' });
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
    expect(recordedMetadata(prisma)).toBeUndefined();
  });

  it('books normally when recording the slot fails', async () => {
    const { service, provider } = build(jneOrder(new Date('2026-09-05T14:59:00+07:00')), { recordFails: true });

    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'JNE-CNOTE-1' });
    expect(provider.createShipment).toHaveBeenCalledTimes(1);
  });
});
