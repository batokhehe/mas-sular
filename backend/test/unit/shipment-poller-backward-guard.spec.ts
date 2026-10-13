import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { readShipmentMetadata } from '../../src/modules/shipment/shipment-metadata';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { ShipmentService } from '../../src/modules/shipment/shipment.service';

/**
 * Backward protection for the tracking pollers (ShipmentSyncService.syncAll - the one
 * the worker runs - and ShipmentService.pollAndUpdate). Both use the SAME shared rule
 * as the JNE webhook (domain/shipment-transition). A stale courier answer (the
 * tracking cache can hold one for two hours) must never move a shipment backwards or
 * out of a terminal state - and the observation must still be kept.
 */

type Row = Record<string, any>;

function world(shipmentStatus: ShipmentStatus, provider = 'jne') {
  const state = {
    shipment: {
      id: 's1', orderId: 'o1', provider, service: 'REG', status: shipmentStatus, cost: 18000,
      trackingNumber: 'AWB1', metadata: { jne: { pickupDatetime: 'p', webhook: { version: 2, keep: true } } } as Row, providerPayload: null as unknown,
    },
    order: {
      id: 'o1', orderNumber: 'BMS-1', status: OrderStatus.DELIVERING as OrderStatus, shippingService: 'REG', shippingServiceName: 'JNE REG',
      user: { name: 'Jane', email: 'jane@test.invalid', phone: '0812' }, address: { phone: '0812' },
    },
    history: [] as Row[],
    orderEvents: [] as Row[],
    outbox: [] as Row[],
    metadataWrites: 0,
    locks: 0,
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const tx: Row = {
    $queryRaw: async () => { state.locks += 1; return []; },
    shipment: {
      findUnique: async () => ({ metadata: clone(state.shipment.metadata) }),
      update: async ({ data }: Row) => {
        if ('metadata' in data) state.metadataWrites += 1;
        Object.assign(state.shipment, clone(data));
        return clone(state.shipment);
      },
      updateMany: async ({ where, data }: Row) => {
        if (where.status !== state.shipment.status) return { count: 0 };
        Object.assign(state.shipment, clone(data));
        return { count: 1 };
      },
    },
    shipmentHistory: { create: async ({ data }: Row) => state.history.push(data) },
    order: {
      updateMany: async ({ where, data }: Row) => {
        if (!where.status.in.includes(state.order.status)) return { count: 0 };
        state.order.status = data.status;
        return { count: 1 };
      },
    },
    orderEvent: { create: async ({ data }: Row) => state.orderEvents.push(data) },
    notificationOutbox: { create: async ({ data }: Row) => state.outbox.push(data) },
  };
  const prisma: Row = {
    // The poller's own query: returns the row as a poll would READ it.
    shipment: { findMany: async () => [{ ...clone(state.shipment), order: clone(state.order) }] },
    $transaction: async (cb: (t: Row) => Promise<unknown>) => cb(tx),
  };
  return { state, prisma, tx };
}

function sync(w: ReturnType<typeof world>, providerStatus: string) {
  const courier = { name: w.state.shipment.provider, trackShipmentRaw: jest.fn().mockResolvedValue({ providerStatus, rawPayload: { status: providerStatus } }) };
  const factory = { get: () => courier, getAll: () => [courier] };
  return { service: new ShipmentSyncService(w.prisma as never, factory as never, new ShipmentStatusMapper()), courier };
}

const rejected = (w: ReturnType<typeof world>) => readShipmentMetadata(w.state.shipment.metadata as never).tracking?.rejected ?? [];

describe('tracking poller (ShipmentSyncService.syncAll): backward protection', () => {
  it('IN_TRANSIT → PICKED_UP from a stale answer is rejected; the observation is recorded once', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    const { service } = sync(w, 'PICKED_UP');

    await expect(service.syncAll()).resolves.toBe(0);
    await service.syncAll(); // the same stale cached answer on the next tick

    expect(w.state.shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
    expect([w.state.history.length, w.state.orderEvents.length, w.state.outbox.length]).toEqual([0, 0, 0]);
    expect(rejected(w)).toEqual([
      expect.objectContaining({
        source: 'poll', provider: 'jne', providerStatus: 'PICKED_UP', mappedStatus: ShipmentStatus.PICKED_UP,
        shipmentStatus: ShipmentStatus.IN_TRANSIT, reason: 'would_regress', firstSeenAt: expect.any(String),
      }),
    ]);
    expect(w.state.metadataWrites).toBe(1); // deduplicated: no write on the repeat tick
    expect(w.state.locks).toBeGreaterThan(0); // merged under the shipment row lock
    // Other metadata (JNE pickup slot, JNE webhook record) untouched.
    expect(w.state.shipment.metadata.jne).toEqual({ pickupDatetime: 'p', webhook: { version: 2, keep: true } });
  });

  it.each([
    ['IN_TRANSIT', 'ON PROCESS'],
    ['PICKED_UP', 'PICKED_UP'],
  ])('DELIVERED → %s is rejected (terminal) - also when a poll reads a shipment that another path just delivered', async (_target, providerStatus) => {
    const w = world(ShipmentStatus.DELIVERED);
    w.state.order.status = OrderStatus.DELIVERED;
    const { service } = sync(w, providerStatus);
    await expect(service.syncAll()).resolves.toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(w.state.order.status).toBe(OrderStatus.DELIVERED);
    expect([w.state.history.length, w.state.outbox.length]).toEqual([0, 0]);
    expect(rejected(w)).toEqual([expect.objectContaining({ shipmentStatus: ShipmentStatus.DELIVERED, reason: 'terminal' })]);
  });

  it('a valid forward transition still applies exactly as before (history, order, one notification)', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    const { service } = sync(w, 'DELIVERED');
    await expect(service.syncAll()).resolves.toBe(1);
    expect(w.state.shipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(w.state.order.status).toBe(OrderStatus.DELIVERED);
    expect(w.state.history).toEqual([expect.objectContaining({ providerStatus: 'DELIVERED', mappedStatus: ShipmentStatus.DELIVERED })]);
    expect(w.state.outbox).toHaveLength(1);
    expect(rejected(w)).toEqual([]);
    expect(w.state.metadataWrites).toBe(0);
  });

  it('Paxel forward progress and interruptions are unchanged (POD, CCS)', async () => {
    const forward = world(ShipmentStatus.IN_TRANSIT, 'paxel');
    await sync(forward, 'POD').service.syncAll();
    expect(forward.state.shipment.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);

    const cancelled = world(ShipmentStatus.CREATED, 'paxel');
    await sync(cancelled, 'CCS').service.syncAll();
    expect(cancelled.state.shipment.status).toBe(ShipmentStatus.CANCELLED);
  });

  it('the shared transition step itself refuses a backwards / out-of-terminal move for ANY caller', async () => {
    const w = world(ShipmentStatus.DELIVERED);
    const { service } = sync(w, 'unused');
    const shipment = { ...w.state.shipment, order: w.state.order };
    for (const target of [ShipmentStatus.IN_TRANSIT, ShipmentStatus.PICKED_UP]) {
      await expect(service.applyTransitionInTx(w.tx as never, shipment as never, target, 'X', {})).resolves.toBe(false);
    }
    const inTransit = world(ShipmentStatus.IN_TRANSIT);
    await expect(sync(inTransit, 'x').service.applyTransitionInTx(inTransit.tx as never, { ...inTransit.state.shipment, order: inTransit.state.order } as never, ShipmentStatus.PICKED_UP, 'X', {})).resolves.toBe(false);
    expect([w.state.history.length, inTransit.state.history.length, inTransit.state.shipment.status]).toEqual([0, 0, ShipmentStatus.IN_TRANSIT]);
  });
});

describe('legacy poller (ShipmentService.pollAndUpdate): backward protection', () => {
  function poll(w: ReturnType<typeof world>, status: ShipmentStatus) {
    const courier = { name: 'jne', trackShipment: jest.fn().mockResolvedValue({ status, rawPayload: {} }) };
    return new ShipmentService(w.prisma as never, { get: () => courier } as never);
  }

  it('a stale IN_TRANSIT → PICKED_UP is rejected and recorded, not written', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    await expect(poll(w, ShipmentStatus.PICKED_UP).pollAndUpdate()).resolves.toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(rejected(w)).toEqual([expect.objectContaining({ mappedStatus: ShipmentStatus.PICKED_UP, reason: 'would_regress' })]);
  });

  it('a forward move still applies; a lost CAS (status moved meanwhile) writes nothing', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    await expect(poll(w, ShipmentStatus.DELIVERED).pollAndUpdate()).resolves.toBe(1);
    expect(w.state.shipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(w.state.outbox).toHaveLength(1);

    const raced = world(ShipmentStatus.IN_TRANSIT);
    const service = poll(raced, ShipmentStatus.DELIVERED);
    const read = raced.prisma.shipment.findMany;
    raced.prisma.shipment.findMany = async () => {
      const rows = await read();
      raced.state.shipment.status = ShipmentStatus.CANCELLED; // another path moved it after the poll read it
      return rows;
    };
    await expect(service.pollAndUpdate()).resolves.toBe(0);
    expect(raced.state.shipment.status).toBe(ShipmentStatus.CANCELLED);
    expect([raced.state.orderEvents.length, raced.state.outbox.length]).toEqual([0, 0]);
  });
});
