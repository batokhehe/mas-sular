import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, ShipmentStatus } from '@prisma/client';
import {
  BOOKING_IN_PROGRESS,
  BookedNotRecordedError,
  RECONCILIATION_REQUIRED,
  ShipmentService,
} from '../../src/modules/shipment/shipment.service';
import { ShipmentReconciliationWorker } from '../../src/modules/shipment/shipment-reconciliation.worker';
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { AmbiguousBookingError, PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import { computeAvailableActions } from '../../src/modules/admin/order-operations.util';
import type { ShipmentMetadata } from '../../src/modules/shipment/shipment-metadata';

/**
 * Duplicate courier booking recovery. A courier booking that may exist must never be
 * sent a second time - by an admin Retry, the reconciliation worker or a replayed
 * settlement - until an operator has reconciled it.
 *
 *   W1  courier accepted, the local transaction failed
 *   W2  the process died (or every write failed) after the courier call
 *   W3  the courier's answer was ambiguous (timeout / 5xx / unconfirmed 2xx)
 *
 * Courier calls are mocks; the store below is one shipment + one order that every
 * Prisma call acts on, so a sequence of attempts behaves as against the database.
 */

const LEASE_MS = 5 * 60 * 1000;
const CONFIG = {
  paxel: { autoPickup: { enabled: false, ...DEFAULT_PICKUP_POLICY } },
  pickupPolicy: DEFAULT_PICKUP_POLICY,
} as unknown as ShippingConfig;
const WORKER_CONFIG = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 50, delayMs: 1000, healthLogIntervalMs: 1000 };
const OUTLET = {
  id: 'out1', name: 'Outlet', postalCode: '40286', addressDetail: 'Jl. Outlet 1', latitude: null, longitude: null,
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Buahbatu' }, village: { name: 'Margasari' },
};
const PICKUP = '2026-11-23T10:00:00.000Z';

type Row = {
  id: string; orderId: string; provider: string; service: string; status: ShipmentStatus;
  trackingNumber: string | null; providerShipmentId: string | null;
  metadata: (ShipmentMetadata & Record<string, unknown>) | null; updatedAt: Date;
};
type Where = {
  id?: string; orderId?: string; trackingNumber?: null; status?: ShipmentStatus | { in: ShipmentStatus[] };
  updatedAt?: { lte: Date };
  OR?: Array<{ status: ShipmentStatus | { in: ShipmentStatus[] }; updatedAt?: { lte: Date } }>;
};

function harness(courier: 'jne' | 'paxel', initial: Partial<Row> = {}) {
  const shipment: Row = {
    id: 'sh1', orderId: 'o1', provider: courier, service: courier === 'jne' ? 'REG' : 'PAXEL_NEXTDAY',
    status: ShipmentStatus.RATE_SELECTED, trackingNumber: null, providerShipmentId: null,
    metadata: { [courier]: { pickupDatetime: PICKUP } },
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    ...initial,
  };
  const order = { id: 'o1', status: OrderStatus.PROCESSING as OrderStatus, trackingNumber: null as string | null };
  const events: Array<{ status: OrderStatus; note: string }> = [];
  const outbox: Array<{ metadata: unknown }> = [];
  /** Failure injection: return an Error to make that Prisma call reject. */
  const faults = {
    tx: null as Error | null,
    shipmentUpdateMany: (_data: Partial<Row>): Error | null => null,
    shipmentUpdate: (_data: Partial<Row>): Error | null => null,
    shipmentFindByOrder: null as Error | null,
  };

  const statusMatches = (cond: Where['status'], s: ShipmentStatus) =>
    cond === undefined ? true : typeof cond === 'object' ? cond.in.includes(s) : cond === s;
  const matches = (w: Where) => {
    if (w.id && w.id !== shipment.id) return false;
    if (w.orderId && w.orderId !== shipment.orderId) return false;
    if (w.trackingNumber === null && shipment.trackingNumber !== null) return false;
    if (!statusMatches(w.status, shipment.status)) return false;
    if (w.updatedAt && shipment.updatedAt > w.updatedAt.lte) return false;
    if (w.OR) {
      return w.OR.some((b) => statusMatches(b.status, shipment.status) && (!b.updatedAt || shipment.updatedAt <= b.updatedAt.lte));
    }
    return true;
  };
  const apply = (data: Partial<Row>) => Object.assign(shipment, JSON.parse(JSON.stringify(data)), { updatedAt: new Date() });
  const loadOrder = () => ({
    id: order.id, orderNumber: 'BMS-20261121-RECOVER1', subtotal: 90_000, totalPrice: 100_000,
    paymentMethod: 'BANK_TRANSFER', shippingProvider: courier, shippingService: shipment.service,
    shippingServiceName: `${courier} label`, outletId: 'out1', status: order.status,
    payment: { verifiedAt: new Date('2026-11-21T03:00:00Z') },
    shipment: { ...shipment, metadata: shipment.metadata ? JSON.parse(JSON.stringify(shipment.metadata)) : null },
    address: {
      recipientName: 'Pelanggan', phone: '081200000000', addressDetail: 'Jl. Melati 5', fullAddress: 'Jl. Melati 5',
      postalCode: '40112', districtId: 'd1', notes: null, latitude: -6.9, longitude: 107.6,
      province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Sumur Bandung' }, village: { name: 'Kebon Pisang' },
    },
    user: { name: 'Pelanggan', email: 'p@example.test', phone: null },
    items: [{ productId: 'p1', quantity: 1, productName: 'Bakso', unitPrice: 90_000, weightGram: 500, lengthCm: 10, widthCm: 10, heightCm: 10, isFragile: false, product: { sku: 'S1', name: 'Bakso', category: { name: 'Makanan' } } }],
  });

  const shipmentUpdateMany = jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
    const fault = faults.shipmentUpdateMany(data);
    if (fault) throw fault;
    if (!matches(where)) return { count: 0 };
    apply(data);
    return { count: 1 };
  });
  const tx = {
    shipment: {
      update: jest.fn(async ({ data }: { data: Partial<Row> }) => apply(data)),
      updateMany: shipmentUpdateMany,
    },
    order: {
      updateMany: jest.fn(async ({ where, data }: { where: { status: { in: OrderStatus[] } }; data: { status: OrderStatus; trackingNumber: string } }) => {
        if (!where.status.in.includes(order.status)) return { count: 0 };
        order.status = data.status;
        order.trackingNumber = data.trackingNumber;
        return { count: 1 };
      }),
    },
    orderEvent: { create: jest.fn(async ({ data }: { data: { status: OrderStatus; note: string } }) => events.push(data)) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn(async ({ data }: { data: { metadata: unknown } }) => outbox.push(data)) },
  };
  const prisma = {
    order: { findUnique: jest.fn(async () => loadOrder()) },
    outlet: { findUnique: jest.fn().mockResolvedValue(OUTLET), findFirst: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: shipmentUpdateMany,
      findUnique: jest.fn(async ({ where }: { where: { id?: string; orderId?: string } }) => {
        if (where.orderId && faults.shipmentFindByOrder) throw faults.shipmentFindByOrder;
        return { ...shipment, metadata: shipment.metadata ? JSON.parse(JSON.stringify(shipment.metadata)) : null };
      }),
      update: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        const fault = faults.shipmentUpdate(data);
        if (fault) throw fault;
        apply(data);
      }),
      // The worker's candidate query: the one order, whatever its state.
      findMany: jest.fn(async () => [{ orderId: 'o1' }]),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
      // A rolled-back transaction leaves no trace: snapshot, run, restore on failure.
      const before = { shipment: JSON.parse(JSON.stringify(shipment)), order: { ...order }, events: events.length, outbox: outbox.length };
      try {
        const out = await cb(tx);
        if (faults.tx) throw faults.tx;
        return out;
      } catch (err) {
        Object.assign(shipment, before.shipment, { updatedAt: new Date(before.shipment.updatedAt) });
        Object.assign(order, before.order);
        events.length = before.events;
        outbox.length = before.outbox;
        throw err;
      }
    }),
  };
  const provider = {
    name: courier,
    supportsAutomaticBooking: true,
    requiresPickupSchedule: courier === 'paxel',
    createShipment: jest.fn(),
  };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  const service = new ShipmentService(prisma as never, factory as never, undefined, new PaxelPickupScheduler(CONFIG));
  const metrics = { setPending: jest.fn(), success: jest.fn(), failure: jest.fn() };
  const worker = new ShipmentReconciliationWorker(prisma as never, service, metrics as never, WORKER_CONFIG as never);
  /** Make the shipment look as if its last write happened long ago (lease expired). */
  const age = () => { shipment.updatedAt = new Date(Date.now() - LEASE_MS - 60_000); };
  return { service, worker, provider, prisma, shipment, order, events, outbox, faults, age };
}

const AWB = { jne: '0291492600000777', paxel: 'CO.EMSULAR-20261121-7-ABCDEF' } as const;
const booked = (courier: 'jne' | 'paxel') => ({
  trackingNumber: AWB[courier], providerShipmentId: AWB[courier], status: ShipmentStatus.CREATED, rawPayload: { ok: true },
});
const DB_DOWN = () => new Error('Connection terminated unexpectedly');

describe.each(['jne', 'paxel'] as const)('%s: courier accepted, local persist failed (W1)', (courier) => {
  it('parks the shipment UNKNOWN with the AWB kept in metadata; no trackingNumber, order not SHIPPED', async () => {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));
    h.faults.tx = DB_DOWN();

    const outcome = await h.service.createForOrderSafe('o1');

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.UNKNOWN });
    expect(outcome.error).toContain(RECONCILIATION_REQUIRED);
    expect(outcome.error).toContain(AWB[courier]);
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.trackingNumber).toBeNull();
    expect(h.shipment.metadata).toMatchObject({
      reconciliationRequired: true,
      [courier]: { pickupDatetime: PICKUP },
      booking: {
        attemptStartedAt: expect.any(String),
        unrecorded: { provider: courier, trackingNumber: AWB[courier], providerShipmentId: AWB[courier], persistError: expect.stringContaining('Connection terminated') },
      },
    });
    expect(h.order).toMatchObject({ status: OrderStatus.PROCESSING, trackingNumber: null });
    expect(h.events).toEqual([]);
    expect(h.outbox).toEqual([]);
  });

  it('createForOrder raises BookedNotRecordedError (ambiguous), never a plain retryable error', async () => {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));
    h.faults.tx = DB_DOWN();
    const error = await h.service.createForOrder('o1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BookedNotRecordedError);
    expect(error).toBeInstanceOf(AmbiguousBookingError);
    expect((error as BookedNotRecordedError).trackingNumber).toBe(AWB[courier]);
  });

  it('admin Retry, the worker and a replayed settlement never send a second booking', async () => {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));
    h.faults.tx = DB_DOWN();
    await h.service.createForOrderSafe('o1');
    h.faults.tx = null; // the database is back

    const retried = await h.service.retry('o1');
    h.age();
    const swept = await h.worker.reconcile();
    const replayed = await h.service.createForOrderSafe('o1');

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(retried).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED });
    expect(swept.booked).toBe(0);
    expect(replayed.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.metadata?.booking?.unrecorded?.trackingNumber).toBe(AWB[courier]); // never lost
    expect(computeAvailableActions({
      status: OrderStatus.PROCESSING, payment: { status: 'PAID' as never, manualReceiptUrl: null },
      shipment: { status: h.shipment.status, trackingNumber: null, trackingUrl: null },
    } as never).retryShipment).toBe(false);
  });
});

describe('every recovery write fails too (W1 + W2)', () => {
  it('the shipment stays PENDING with the attempt marker, and is parked - never re-booked - once the lease expires', async () => {
    const h = harness('paxel');
    h.provider.createShipment.mockResolvedValue(booked('paxel'));
    h.faults.tx = DB_DOWN();
    // Neither the UNKNOWN record nor the FAILED/UNKNOWN mark can be written.
    h.faults.shipmentUpdateMany = (data) =>
      data.status === ShipmentStatus.UNKNOWN || data.status === ShipmentStatus.FAILED ? DB_DOWN() : null;

    const outcome = await h.service.createForOrderSafe('o1');
    expect(outcome.status).toBe(ShipmentStatus.UNKNOWN); // reported as needing reconciliation
    expect(h.shipment.status).toBe(ShipmentStatus.PENDING);
    expect(h.shipment.metadata?.booking?.attemptStartedAt).toEqual(expect.any(String));

    // While the lease runs, the claim refuses (nothing sent).
    expect(await h.service.retry('o1')).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });

    h.faults.tx = null;
    h.faults.shipmentUpdateMany = () => null;
    h.age();
    const swept = await h.worker.reconcile();
    const retried = await h.service.retry('o1');

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(swept).toMatchObject({ booked: 0, failed: 1 });
    expect(retried).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED });
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.metadata).toMatchObject({ reconciliationRequired: true, paxel: { pickupDatetime: PICKUP } });
    expect(h.order.status).toBe(OrderStatus.PROCESSING);
  });

  it('a failure mark whose metadata read failed moves the status only, never wiping stored metadata', async () => {
    const h = harness('jne');
    h.provider.createShipment.mockRejectedValue(new PermanentError('JNE rejected the pickup: invalid zip', 'jne'));
    h.faults.shipmentFindByOrder = DB_DOWN();

    const outcome = await h.service.createForOrderSafe('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
    expect(h.shipment.metadata).toMatchObject({ jne: { pickupDatetime: PICKUP }, booking: { attemptStartedAt: expect.any(String) } });
  });
});

describe('process crash or ambiguous answer (W2, W3)', () => {
  it.each(['jne', 'paxel'] as const)('%s: a crash after the courier call (stale PENDING + marker) is parked by the worker and by Retry', async (courier) => {
    const h = harness(courier, {
      status: ShipmentStatus.PENDING,
      metadata: { [courier]: { pickupDatetime: PICKUP }, booking: { attemptStartedAt: '2026-11-21T03:00:00.000Z', attemptProvider: courier } },
    });
    h.age();
    h.provider.createShipment.mockResolvedValue(booked(courier));

    const swept = await h.worker.reconcile();
    const retried = await h.service.retry('o1');

    expect(h.provider.createShipment).not.toHaveBeenCalled();
    expect(swept).toMatchObject({ booked: 0, failed: 1 });
    expect(retried.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null });
    expect(h.shipment.metadata).toMatchObject({ reconciliationRequired: true, booking: { attemptStartedAt: '2026-11-21T03:00:00.000Z' } });
  });

  it('a PENDING attempt still inside its lease is left alone (in flight, not interrupted)', async () => {
    const h = harness('paxel', {
      status: ShipmentStatus.PENDING,
      updatedAt: new Date(),
      metadata: { paxel: { pickupDatetime: PICKUP }, booking: { attemptStartedAt: new Date().toISOString() } },
    });
    const outcome = await h.service.retry('o1');
    expect(outcome).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    expect(h.shipment.status).toBe(ShipmentStatus.PENDING);
    expect(h.provider.createShipment).not.toHaveBeenCalled();
  });

  it('a legacy stale PENDING without the marker keeps the old reclaim-and-book behaviour', async () => {
    const h = harness('jne', { status: ShipmentStatus.PENDING, metadata: { jne: { pickupDatetime: PICKUP } } });
    h.age();
    h.provider.createShipment.mockResolvedValue(booked('jne'));
    const outcome = await h.service.retry('o1');
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.jne });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
  });

  it.each(['jne', 'paxel'] as const)('%s: an ambiguous courier answer parks UNKNOWN and no path books again', async (courier) => {
    const h = harness(courier);
    h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError(`${courier} booking outcome unknown - network error: timeout`, courier));
    h.provider.createShipment.mockResolvedValue(booked(courier));

    await h.service.createForOrderSafe('o1');
    await h.service.retry('o1');
    h.age();
    await h.worker.reconcile();

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null });
    expect(h.shipment.metadata?.reconciliationRequired).toBe(true);
  });

  it('if the attempt marker cannot be written, the courier is never called and the shipment is safely FAILED', async () => {
    const h = harness('paxel');
    // The marker write is the only metadata.booking write that does not change the status.
    h.faults.shipmentUpdateMany = (data) =>
      data.status === undefined && (data as { metadata?: { booking?: unknown } }).metadata?.booking ? DB_DOWN() : null;
    const outcome = await h.service.createForOrderSafe('o1');
    expect(h.provider.createShipment).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
  });
});

describe('manual reconciliation of an UNKNOWN shipment', () => {
  async function parkedAfterPersistFailure(courier: 'jne' | 'paxel') {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));
    h.faults.tx = DB_DOWN();
    await h.service.createForOrderSafe('o1');
    h.faults.tx = null;
    return h;
  }

  it.each(['jne', 'paxel'] as const)('%s booked: records the captured AWB and ships the order once, without calling the courier', async (courier) => {
    const h = await parkedAfterPersistFailure(courier);

    const outcome = await h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB[courier], note: 'checked courier dashboard' }, 'ops@masular.test');

    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1); // only the original booking
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB[courier], providerShipmentId: AWB[courier] });
    expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();
    expect(h.shipment.metadata?.booking).toMatchObject({
      unrecorded: { trackingNumber: AWB[courier] },
      reconciliation: { outcome: 'booked', trackingNumber: AWB[courier], resolvedBy: 'ops@masular.test', note: 'checked courier dashboard' },
    });
    expect(h.order).toMatchObject({ status: OrderStatus.SHIPPED, trackingNumber: AWB[courier] });
    expect(h.events).toEqual([expect.objectContaining({ status: OrderStatus.SHIPPED, note: `Shipment reconciled (${courier})` })]);
    expect(h.outbox).toEqual([expect.objectContaining({ metadata: { source: 'shipment.reconciliation' } })]);

    // Idempotent afterwards: no second booking, no second reconciliation.
    expect(await h.service.retry('o1')).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    await expect(h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB[courier] })).rejects.toBeInstanceOf(ConflictException);
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.events).toHaveLength(1);
  });

  it('refuses an AWB different from the one the courier already issued, and changes nothing', async () => {
    const h = await parkedAfterPersistFailure('paxel');
    await expect(h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: 'CO.EMSULAR-20261121-8-OTHER1' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null });
    expect(h.order.status).toBe(OrderStatus.PROCESSING);
  });

  it('refuses a malformed AWB', async () => {
    const h = harness('jne', { status: ShipmentStatus.UNKNOWN, metadata: { reconciliationRequired: true } });
    for (const bad of ['', '  ', 'a b c', 'x', '<script>']) {
      await expect(h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
  });

  it('only an UNKNOWN shipment can be reconciled', async () => {
    for (const status of [ShipmentStatus.FAILED, ShipmentStatus.PENDING, ShipmentStatus.RATE_SELECTED]) {
      const h = harness('jne', { status });
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked' })).rejects.toBeInstanceOf(ConflictException);
      expect(h.shipment.status).toBe(status);
    }
  });

  it('not_booked is refused while the courier is KNOWN to hold an AWB, until it was cancelled at the courier', async () => {
    const h = await parkedAfterPersistFailure('paxel');
    await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);

    const outcome = await h.service.reconcileBooking('o1', { outcome: 'not_booked', cancelledAtCourier: true }, 'ops@masular.test');
    expect(outcome).toMatchObject({ ok: true, status: ShipmentStatus.FAILED });
    expect(h.shipment.metadata?.booking?.reconciliation).toMatchObject({ outcome: 'not_booked', cancelledAtCourier: true });
    expect(h.shipment.metadata?.booking?.unrecorded?.trackingNumber).toBe(AWB.paxel); // history kept
  });

  it('not_booked after an ambiguous timeout makes Retry available again, and the retry books exactly once', async () => {
    const h = harness('jne');
    h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError('JNE booking outcome unknown - network error: timeout', 'jne'));
    await h.service.createForOrderSafe('o1');
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);

    await h.service.reconcileBooking('o1', { outcome: 'not_booked', note: 'JNE confirmed no CNOTE' });
    expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
    expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();

    h.provider.createShipment.mockResolvedValue(booked('jne'));
    const outcome = await h.service.retry('o1');
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.jne });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(2);
    expect(h.order.status).toBe(OrderStatus.SHIPPED);
  });
});

describe('unchanged behaviour', () => {
  it.each(['jne', 'paxel'] as const)('%s: a normal booking writes the attempt marker BEFORE the courier call, then records and ships once', async (courier) => {
    const h = harness(courier);
    let markerAtCall: unknown;
    h.provider.createShipment.mockImplementation(async () => {
      markerAtCall = h.shipment.metadata?.booking?.attemptStartedAt;
      return booked(courier);
    });

    const outcome = await h.service.createForOrderSafe('o1');

    expect(markerAtCall).toEqual(expect.any(String));
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.order).toMatchObject({ status: OrderStatus.SHIPPED, trackingNumber: AWB[courier] });
    expect(h.events).toEqual([expect.objectContaining({ status: OrderStatus.SHIPPED, note: `Shipment created (${courier})` })]);
    expect(h.outbox).toEqual([expect.objectContaining({ metadata: { source: 'shipment.auto_booking' } })]);
  });

  it('a definitive refusal stays FAILED and retryable; the retry books once', async () => {
    const h = harness('paxel');
    h.provider.createShipment.mockRejectedValueOnce(new PermanentError('provider 400: invalid destination', 'paxel'));
    const failed = await h.service.createForOrderSafe('o1');
    expect(failed).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();

    h.provider.createShipment.mockResolvedValue(booked('paxel'));
    const retried = await h.service.retry('o1');
    expect(retried).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.paxel });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(2);
  });
});
