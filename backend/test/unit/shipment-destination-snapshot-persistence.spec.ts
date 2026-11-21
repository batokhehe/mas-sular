import { Logger } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';
import { PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { ShipmentDestinationSnapshotV1 } from '../../src/modules/shipment/domain/destination-snapshot';

/**
 * ShipmentService persists Shipment.destinationSnapshot with the AWB of a SUCCESSFUL
 * booking, in the same transaction; a failed booking writes none; a local persistence
 * failure after the courier accepted keeps the existing recovery path and logs the AWB.
 * Same harness shape as shipment.service.spec.ts (mocked Prisma + provider).
 */

const ORDER = {
  id: 'o1',
  orderNumber: 'INV-1',
  shippingProvider: 'paxel',
  shippingService: 'PAXEL_REGULAR',
  shippingServiceName: 'Paxel Regular',
  shipment: { id: 'sh1', provider: 'paxel', service: 'Paxel Regular', status: ShipmentStatus.RATE_SELECTED, trackingNumber: null, metadata: { pickupDatetime: '2026-09-01T10:30:00.000Z' } },
  address: { recipientName: 'Budi', phone: '628123', addressDetail: 'Jl. Test 1', fullAddress: 'Jl. Test 1', postalCode: '40131', latitude: -6.8, longitude: 107.5 },
  user: { name: 'Budi', email: 'budi@test.com', phone: null },
  items: [{ quantity: 2 }],
};
const OUTLET = { id: 'out1', name: 'Pusat', postalCode: '40111', latitude: -6.9, longitude: 107.6 };

const SNAPSHOT: ShipmentDestinationSnapshotV1 = {
  version: 1, provider: 'paxel', capturedAt: '2026-11-20T00:00:00.000Z', recipientName: 'Budi', phone: '628123',
  addressLines: ['Jl. Test 1'], village: 'Pasteur', district: 'Sukajadi', city: 'Kota Bandung', province: 'Jawa Barat',
  postalCode: '40131', note: null, addressTruncated: false, coordinatesSubmitted: true, providerFields: { name: 'Budi' },
};

function buildTx() {
  return {
    shipment: { update: jest.fn().mockResolvedValue({}) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderEvent: { create: jest.fn().mockResolvedValue({}) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
}

function build(createShipment: jest.Mock) {
  const tx = buildTx();
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(ORDER) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET), findUnique: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ metadata: ORDER.shipment.metadata }),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  // Pickup scheduling is covered elsewhere; this provider books without one.
  const provider = { name: 'paxel', createShipment };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ShipmentService(prisma as any, { get: jest.fn().mockReturnValue(provider) } as any);
  return { service, prisma, tx };
}

const success = (extra: Record<string, unknown> = {}) =>
  jest.fn().mockResolvedValue({ trackingNumber: 'CO.EMSULAR-20261030-1-CYOCBX', providerShipmentId: 'CO.EMSULAR-20261030-1-CYOCBX', status: ShipmentStatus.CREATED, rawPayload: { ok: true }, ...extra });

describe('ShipmentService — destination snapshot persistence', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a successful booking stores the AWB and the destination snapshot in ONE shipment update, in the transaction', async () => {
    const { service, prisma, tx } = build(success({ destinationSnapshot: SNAPSHOT }));
    const outcome = await service.createForOrder('o1');

    expect(outcome).toMatchObject({ ok: true, trackingNumber: 'CO.EMSULAR-20261030-1-CYOCBX' });
    expect(tx.shipment.update).toHaveBeenCalledTimes(1);
    const data = tx.shipment.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ trackingNumber: 'CO.EMSULAR-20261030-1-CYOCBX', providerShipmentId: 'CO.EMSULAR-20261030-1-CYOCBX', status: ShipmentStatus.CREATED });
    expect(data.destinationSnapshot).toEqual(SNAPSHOT);
    // Never written outside the transaction.
    expect(prisma.shipment.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ destinationSnapshot: expect.anything() }) }));
  });

  it('a provider without a snapshot leaves the column untouched (existing behaviour)', async () => {
    const { service, tx } = build(success());
    await service.createForOrder('o1');
    expect(tx.shipment.update.mock.calls[0][0].data).not.toHaveProperty('destinationSnapshot');
  });

  it('a failed booking writes no snapshot and is marked FAILED exactly as before', async () => {
    const { service, prisma, tx } = build(jest.fn().mockRejectedValue(new PermanentError('Paxel refused', 'paxel')));
    const outcome = await service.createForOrderSafe('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(tx.shipment.update).not.toHaveBeenCalled();
    for (const call of [...prisma.shipment.updateMany.mock.calls, ...prisma.shipment.update.mock.calls]) {
      expect(call[0].data).not.toHaveProperty('destinationSnapshot');
    }
  });

  it('local persistence failure after the courier accepted: AWB logged, error propagates to the existing recovery path', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, prisma, tx } = build(success({ destinationSnapshot: SNAPSHOT }));
    tx.shipment.update.mockRejectedValueOnce(new Error('connection reset'));

    await expect(service.createForOrder('o1')).rejects.toThrow('connection reset');
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'shipment.persist_failed_after_booking', orderId: 'o1', provider: 'paxel', tracking: 'CO.EMSULAR-20261030-1-CYOCBX' }),
    );

    // The never-throwing wrapper used by settlement/retry handles it as it always did.
    tx.shipment.update.mockRejectedValueOnce(new Error('connection reset'));
    const outcome = await service.createForOrderSafe('o1');
    expect(outcome.ok).toBe(false);
    expect(prisma.shipment.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { orderId: 'o1', trackingNumber: null, bookingAttemptId: expect.any(String), status: { in: [ShipmentStatus.PENDING, ShipmentStatus.UNKNOWN] } },
        data: expect.objectContaining({ status: ShipmentStatus.UNKNOWN }),
      }),
    );
  });
});
