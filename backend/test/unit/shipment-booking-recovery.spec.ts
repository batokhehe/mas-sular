import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';
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
 * settlement - until an operator has reconciled it with evidence.
 *
 *   W1  courier accepted, the local transaction failed
 *   W2  the process died / hung (or every write failed) after the courier call
 *   W3  the courier's answer was ambiguous (timeout / 5xx / unconfirmed 2xx)
 *   R   concurrent attempts: only the owner of the atomic claim calls the courier,
 *       and no stale attempt can change a newer attempt's row
 *
 * Courier calls are mocks. The store below is one shipment + one order that every
 * Prisma call acts on. Every call yields to the event loop first, so concurrent
 * callers really interleave; each conditional write evaluates its WHERE and applies
 * in one synchronous step - the atomic compare-and-set PostgreSQL gives one UPDATE.
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
const EVIDENCE = { confirmNoActiveBooking: true, courierCheckReference: 'CS ticket #48213' } as const;

type Row = {
  id: string; orderId: string; provider: string; service: string; status: ShipmentStatus;
  trackingNumber: string | null; providerShipmentId: string | null;
  metadata: (ShipmentMetadata & Record<string, unknown>) | null; updatedAt: Date;
  bookingAttemptId: string | null; bookingAttemptStartedAt: Date | null;
};
type Where = { [key: string]: unknown; OR?: Where[] };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const clone = <T>(v: T): T => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const notFound = () => new Prisma.PrismaClientKnownRequestError('No record was found for an update.', { code: 'P2025', clientVersion: 'test' });

/** Prisma WHERE semantics for the fields these paths use. */
function matchesWhere(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((branch) => matchesWhere(row, branch));
    const value = (row as Record<string, unknown>)[key];
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond === 'object') {
      const c = cond as { in?: unknown[]; lte?: Date };
      if (c.in) return c.in.includes(value);
      if (c.lte) return value instanceof Date && value.getTime() <= c.lte.getTime();
    }
    return value === cond;
  });
}

function harness(courier: 'jne' | 'paxel', initial: Partial<Row> = {}) {
  const shipment: Row = {
    id: 'sh1', orderId: 'o1', provider: courier, service: courier === 'jne' ? 'REG' : 'PAXEL_NEXTDAY',
    status: ShipmentStatus.RATE_SELECTED, trackingNumber: null, providerShipmentId: null,
    metadata: { [courier]: { pickupDatetime: PICKUP } },
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    bookingAttemptId: null, bookingAttemptStartedAt: null,
    ...initial,
  };
  const order = { id: 'o1', status: OrderStatus.PROCESSING as OrderStatus, trackingNumber: null as string | null };
  const events: Array<{ status: OrderStatus; note: string }> = [];
  const outbox: Array<{ metadata: unknown }> = [];
  /** Courier create accepted per the integration log (null = none recorded). */
  const integrationLog = { accepted: null as null | { provider: 'JNE' | 'PAXEL'; createdAt: Date; correlationId: string | null }, fault: null as Error | null };
  /** Failure injection: return an Error to make that Prisma call reject. */
  const faults = {
    tx: null as Error | null,
    shipmentUpdateMany: (_data: Partial<Row>): Error | null => null,
    shipmentFindByOrder: null as Error | null,
  };

  const snapshot = (): Row => ({
    ...shipment,
    metadata: clone(shipment.metadata),
  });
  const apply = (data: Partial<Row>) => {
    const { bookingAttemptStartedAt, ...rest } = data;
    Object.assign(shipment, clone(rest), { updatedAt: new Date() });
    if (bookingAttemptStartedAt !== undefined) shipment.bookingAttemptStartedAt = bookingAttemptStartedAt;
  };
  const loadOrder = () => ({
    id: order.id, orderNumber: 'BMS-20261121-RECOVER1', subtotal: 90_000, totalPrice: 100_000,
    paymentMethod: 'BANK_TRANSFER', shippingProvider: courier, shippingService: shipment.service,
    shippingServiceName: `${courier} label`, outletId: 'out1', status: order.status,
    payment: { verifiedAt: new Date('2026-11-21T03:00:00Z') },
    shipment: snapshot(),
    address: {
      recipientName: 'Pelanggan', phone: '081200000000', addressDetail: 'Jl. Melati 5', fullAddress: 'Jl. Melati 5',
      postalCode: '40112', districtId: 'd1', notes: null, latitude: -6.9, longitude: 107.6,
      province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Sumur Bandung' }, village: { name: 'Kebon Pisang' },
    },
    user: { name: 'Pelanggan', email: 'p@example.test', phone: null },
    items: [{ productId: 'p1', quantity: 1, productName: 'Bakso', unitPrice: 90_000, weightGram: 500, lengthCm: 10, widthCm: 10, heightCm: 10, isFragile: false, product: { sku: 'S1', name: 'Bakso', category: { name: 'Makanan' } } }],
  });

  const shipmentUpdateMany = jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
    await tick();
    const fault = faults.shipmentUpdateMany(data);
    if (fault) throw fault;
    if (!matchesWhere(shipment, where)) return { count: 0 };
    apply(data);
    return { count: 1 };
  });
  // update() with extra filters (Prisma extendedWhereUnique): no match -> P2025.
  const shipmentUpdate = jest.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
    await tick();
    if (!matchesWhere(shipment, where)) throw notFound();
    apply(data);
    return snapshot();
  });
  const tx = {
    shipment: { update: shipmentUpdate, updateMany: shipmentUpdateMany },
    order: {
      updateMany: jest.fn(async ({ where, data }: { where: { status: { in: OrderStatus[] } }; data: { status: OrderStatus; trackingNumber: string } }) => {
        await tick();
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
    order: { findUnique: jest.fn(async () => { await tick(); return loadOrder(); }) },
    outlet: { findUnique: jest.fn().mockResolvedValue(OUTLET), findFirst: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: shipmentUpdateMany,
      update: shipmentUpdate,
      findUnique: jest.fn(async ({ where }: { where: { id?: string; orderId?: string } }) => {
        await tick();
        if (where.orderId && faults.shipmentFindByOrder) throw faults.shipmentFindByOrder;
        return snapshot();
      }),
      // The worker's candidate query: the one order, whatever its state.
      findMany: jest.fn(async () => [{ orderId: 'o1' }]),
    },
    integrationApiLog: {
      findFirst: jest.fn(async () => {
        await tick();
        if (integrationLog.fault) throw integrationLog.fault;
        return integrationLog.accepted;
      }),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => {
      // A rolled-back transaction leaves no trace: snapshot, run, restore on failure.
      const before = { shipment: snapshot(), order: { ...order }, events: events.length, outbox: outbox.length };
      try {
        const out = await cb(tx);
        if (faults.tx) throw faults.tx;
        return out;
      } catch (err) {
        Object.assign(shipment, before.shipment);
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
  /** Let the current attempt's lease expire (and the row look idle for the worker). */
  const age = () => {
    const past = new Date(Date.now() - LEASE_MS - 60_000);
    shipment.updatedAt = past;
    if (shipment.bookingAttemptStartedAt) shipment.bookingAttemptStartedAt = past;
  };
  /**
   * Hold the next courier call open until released, recording the attempt that made
   * it (read from the row at call time).
   */
  const gateNextCall = () => {
    const gate = deferred<ReturnType<typeof booked>>();
    const seen = { attemptId: null as string | null, status: null as ShipmentStatus | null };
    const started = deferred<void>();
    provider.createShipment.mockImplementationOnce(async () => {
      seen.attemptId = shipment.bookingAttemptId;
      seen.status = shipment.status;
      started.resolve();
      return gate.promise;
    });
    return { release: gate.resolve, fail: gate.reject, started: started.promise, seen };
  };
  return { service, worker, provider, prisma, shipment, order, events, outbox, faults, integrationLog, age, gateNextCall };
}

const AWB = { jne: '0291492600000777', paxel: 'CO.EMSULAR-20261121-7-ABCDEF' } as const;
const AWB_2 = { jne: '0291492600000888', paxel: 'CO.EMSULAR-20261121-8-BCDEFA' } as const;
const booked = (courier: 'jne' | 'paxel', awb: string = AWB[courier]) => ({
  trackingNumber: awb, providerShipmentId: awb, status: ShipmentStatus.CREATED, rawPayload: { ok: true },
});
const DB_DOWN = () => new Error('Connection terminated unexpectedly');
const retryOffered = (status: ShipmentStatus) =>
  computeAvailableActions({
    status: OrderStatus.PROCESSING, payment: { status: 'PAID' as never, manualReceiptUrl: null },
    shipment: { status, trackingNumber: null, trackingUrl: null },
  } as never).retryShipment;

// ---------------------------------------------------------------------------
describe('R: booking attempt ownership (atomic claim + compare-and-set)', () => {
  it.each(['jne', 'paxel'] as const)('%s: payment verification and admin Retry at the same moment book exactly once', async (courier) => {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));

    const [verify, retry] = await Promise.all([h.service.createForOrderSafe('o1'), h.service.retry('o1')]);

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    // The loser either saw the claim in flight or, finishing later, the winner's AWB
    // (idempotent success) - never a booking of its own.
    for (const o of [verify, retry]) {
      expect([`ok:${AWB[courier]}`, `skip:${BOOKING_IN_PROGRESS}`]).toContain(o.ok ? `ok:${o.trackingNumber}` : `skip:${o.error}`);
    }
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.events).toHaveLength(1);
  });

  it('the reconciliation worker and an admin Retry at the same moment book exactly once', async () => {
    const h = harness('paxel');
    h.provider.createShipment.mockResolvedValue(booked('paxel'));

    await Promise.all([h.worker.reconcile(), h.service.retry('o1'), h.service.createForOrderSafe('o1')]);

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB.paxel });
    expect(h.events).toHaveLength(1);
  });

  it('the owner token is written by the claim itself, before the courier is called', async () => {
    const h = harness('jne');
    const call = h.gateNextCall();
    const owner = h.service.createForOrderSafe('o1');
    await call.started;

    expect(call.seen).toEqual({ attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: ShipmentStatus.PENDING });
    expect(h.shipment.bookingAttemptStartedAt).toBeInstanceOf(Date);
    call.release(booked('jne'));
    await owner;
    expect(h.shipment.bookingAttemptId).toBe(call.seen.attemptId);
  });

  it('a second process during the attempt cannot claim, replace the owner token, or move the lease', async () => {
    const h = harness('jne');
    const call = h.gateNextCall();
    const owner = h.service.createForOrderSafe('o1');
    await call.started;
    const token = h.shipment.bookingAttemptId;
    const startedAt = h.shipment.bookingAttemptStartedAt;

    const contenders = await Promise.all([h.service.retry('o1'), h.service.createForOrderSafe('o1'), h.worker.reconcile()]);

    expect(contenders[0]).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    expect(contenders[1]).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: token, bookingAttemptStartedAt: startedAt });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);

    call.release(booked('jne'));
    expect(await owner).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.jne });
  });

  it('after the lease expires a contender parks the attempt (same owner) instead of claiming it; the late success still records', async () => {
    const h = harness('paxel');
    const call = h.gateNextCall();
    const owner = h.service.createForOrderSafe('o1');
    await call.started;
    const token = h.shipment.bookingAttemptId;
    h.age();

    const parked = await h.service.retry('o1');
    expect(parked).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, bookingAttemptId: token });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);

    // The hung attempt comes back with the courier's AWB: it still owns the row.
    call.release(booked('paxel'));
    expect(await owner).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.paxel });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB.paxel, bookingAttemptId: token });
    expect(h.order.status).toBe(OrderStatus.SHIPPED);
  });

  it('a stale attempt can never change the row of a newer attempt (success, recovery or failure mark)', async () => {
    const h = harness('jne');
    // Attempt A hangs in the courier call past its lease and is parked.
    const callA = h.gateNextCall();
    const attemptA = h.service.createForOrderSafe('o1');
    await callA.started;
    const tokenA = h.shipment.bookingAttemptId;
    h.age();
    await h.worker.reconcile();
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);

    // An operator confirms with JNE that nothing is booked; attempt B starts.
    await h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE });
    const callB = h.gateNextCall();
    const attemptB = h.service.retry('o1');
    await callB.started;
    const tokenB = h.shipment.bookingAttemptId;
    expect(tokenB).not.toBe(tokenA);
    const rowB = { status: h.shipment.status, bookingAttemptId: tokenB, bookingAttemptStartedAt: h.shipment.bookingAttemptStartedAt, metadata: JSON.parse(JSON.stringify(h.shipment.metadata)) };

    // A's late success: its transaction, its recovery record and its failure mark
    // are all compare-and-set on token A - none may touch B's row.
    callA.release(booked('jne', AWB.jne));
    const outcomeA = await attemptA;
    expect(outcomeA).toMatchObject({ ok: false, status: ShipmentStatus.UNKNOWN });
    expect(h.shipment).toMatchObject({ ...rowB, trackingNumber: null });
    expect(h.order.status).toBe(OrderStatus.PROCESSING);

    // A's definitive failure would not release B's claim either: B completes normally.
    callB.release(booked('jne', AWB_2.jne));
    expect(await attemptB).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB_2.jne });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB_2.jne, bookingAttemptId: tokenB });
    expect(h.events).toHaveLength(1);
  });

  it("a process failing BEFORE its claim never releases another process's live claim", async () => {
    const h = harness('jne');
    const call = h.gateNextCall();
    const owner = h.service.createForOrderSafe('o1');
    await call.started;
    const token = h.shipment.bookingAttemptId;

    // The contender fails before it ever claims (here: the outlet lookup).
    h.prisma.outlet.findUnique.mockRejectedValueOnce(DB_DOWN());
    const contender = await h.service.createForOrderSafe('o1');
    expect(contender.ok).toBe(false);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: token });

    // ...so nothing else can claim it while the owner is at the courier.
    expect(await h.service.retry('o1')).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    call.release(booked('jne'));
    await owner;
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
  });

  it('a pre-claim failure never turns an UNKNOWN shipment into a retryable FAILED', async () => {
    const h = harness('paxel', { status: ShipmentStatus.UNKNOWN, metadata: { reconciliationRequired: true, paxel: { pickupDatetime: PICKUP } } });
    // The order is loaded while the row still looked bookable, then fails pre-claim.
    h.prisma.order.findUnique.mockImplementationOnce(async () => {
      throw DB_DOWN();
    });
    await h.service.createForOrderSafe('o1');
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.provider.createShipment).not.toHaveBeenCalled();
  });

  it('if the claim itself cannot be written, the courier is never called', async () => {
    const h = harness('paxel');
    h.faults.shipmentUpdateMany = (data) => (data.status === ShipmentStatus.PENDING ? DB_DOWN() : null);
    const outcome = await h.service.createForOrderSafe('o1');
    expect(h.provider.createShipment).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.FAILED, bookingAttemptId: null });
  });
});

// ---------------------------------------------------------------------------
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
        unrecorded: {
          provider: courier, trackingNumber: AWB[courier], providerShipmentId: AWB[courier],
          persistError: expect.stringContaining('Connection terminated'), attemptId: h.shipment.bookingAttemptId,
        },
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
    expect(retryOffered(h.shipment.status)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('every recovery write fails too (W1 + W2)', () => {
  it('stays PENDING with its owner, then the worker parks it - never re-booked', async () => {
    const h = harness('paxel');
    h.provider.createShipment.mockResolvedValue(booked('paxel'));
    h.faults.tx = DB_DOWN();
    // Neither the UNKNOWN record nor the FAILED/UNKNOWN mark can be written.
    h.faults.shipmentUpdateMany = (data) =>
      data.status === ShipmentStatus.UNKNOWN || data.status === ShipmentStatus.FAILED ? DB_DOWN() : null;

    const outcome = await h.service.createForOrderSafe('o1');
    expect(outcome.status).toBe(ShipmentStatus.UNKNOWN); // reported as needing reconciliation
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: expect.any(String) });
    expect(h.shipment.metadata?.booking?.unrecorded).toBeUndefined(); // the AWB is only in the logs now

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

  it('when only the first recovery write fails, the failure mark keeps the AWB (second chance)', async () => {
    const h = harness('jne');
    h.provider.createShipment.mockResolvedValue(booked('jne'));
    h.faults.tx = DB_DOWN();
    let unknownWrites = 0;
    h.faults.shipmentUpdateMany = (data) => (data.status === ShipmentStatus.UNKNOWN && unknownWrites++ === 0 ? DB_DOWN() : null);

    await h.service.createForOrderSafe('o1');

    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.metadata?.booking?.unrecorded).toMatchObject({ trackingNumber: AWB.jne, attemptId: h.shipment.bookingAttemptId });
  });

  it('a failure mark whose metadata read failed moves the status only, never wiping stored metadata', async () => {
    const h = harness('jne');
    h.provider.createShipment.mockRejectedValue(new PermanentError('JNE rejected the pickup: invalid zip', 'jne'));
    h.faults.shipmentFindByOrder = DB_DOWN();

    const outcome = await h.service.createForOrderSafe('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
    expect(h.shipment.metadata).toEqual({ jne: { pickupDatetime: PICKUP } });
  });
});

// ---------------------------------------------------------------------------
describe('process crash or ambiguous answer (W2, W3)', () => {
  it.each(['jne', 'paxel'] as const)('%s: a crash after the courier call (owned PENDING past its lease) is parked by the worker and by Retry', async (courier) => {
    const past = new Date(Date.now() - LEASE_MS - 60_000);
    const h = harness(courier, {
      status: ShipmentStatus.PENDING, bookingAttemptId: '11111111-1111-4111-8111-111111111111', bookingAttemptStartedAt: past, updatedAt: past,
    });
    h.provider.createShipment.mockResolvedValue(booked(courier));

    const swept = await h.worker.reconcile();
    const retried = await h.service.retry('o1');

    expect(h.provider.createShipment).not.toHaveBeenCalled();
    expect(swept).toMatchObject({ booked: 0, failed: 1 });
    expect(retried.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null, bookingAttemptId: '11111111-1111-4111-8111-111111111111' });
    expect(h.shipment.metadata).toMatchObject({ reconciliationRequired: true });
  });

  it('an owned PENDING still inside its lease is left alone (in flight, not interrupted)', async () => {
    const h = harness('paxel', {
      status: ShipmentStatus.PENDING, updatedAt: new Date(),
      bookingAttemptId: '22222222-2222-4222-8222-222222222222', bookingAttemptStartedAt: new Date(),
    });
    const outcome = await h.service.retry('o1');
    expect(outcome).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS });
    expect(h.shipment.status).toBe(ShipmentStatus.PENDING);
    expect(h.provider.createShipment).not.toHaveBeenCalled();
  });

  it('a legacy stale PENDING without an owner keeps the old reclaim-and-book behaviour', async () => {
    const h = harness('jne', { status: ShipmentStatus.PENDING });
    h.age();
    h.provider.createShipment.mockResolvedValue(booked('jne'));
    const outcome = await h.service.retry('o1');
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB.jne });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.shipment.bookingAttemptId).toEqual(expect.any(String));
  });

  it.each(['jne', 'paxel'] as const)('%s: an ambiguous courier answer parks UNKNOWN and no path books again', async (courier) => {
    const h = harness(courier);
    h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError(`${courier} booking outcome unknown - network error: timeout`, courier));
    h.provider.createShipment.mockResolvedValue(booked(courier));

    await h.service.createForOrderSafe('o1');
    await Promise.all([h.service.retry('o1'), h.service.createForOrderSafe('o1')]);
    h.age();
    await h.worker.reconcile();

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null });
    expect(h.shipment.metadata?.reconciliationRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('manual reconciliation of an UNKNOWN shipment', () => {
  async function parkedAfterPersistFailure(courier: 'jne' | 'paxel') {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));
    h.faults.tx = DB_DOWN();
    await h.service.createForOrderSafe('o1');
    h.faults.tx = null;
    h.age(); // the attempt is over
    return h;
  }
  async function parkedAfterTimeout(courier: 'jne' | 'paxel') {
    const h = harness(courier);
    h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError(`${courier} booking outcome unknown - network error: timeout`, courier));
    await h.service.createForOrderSafe('o1');
    h.age();
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

  it('two admins reconciling at the same moment: exactly one wins, the order ships once', async () => {
    const h = await parkedAfterPersistFailure('paxel');
    const results = await Promise.allSettled([
      h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB.paxel }, 'ops-a@masular.test'),
      h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB.paxel }, 'ops-b@masular.test'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(h.events).toHaveLength(1);
    expect(h.outbox).toHaveLength(1);
    expect(h.order.status).toBe(OrderStatus.SHIPPED);
  });

  it('booked and not_booked racing: only one applies, never both', async () => {
    const h = await parkedAfterTimeout('jne');
    const results = await Promise.allSettled([
      h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB.jne }),
      h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([ShipmentStatus.CREATED, ShipmentStatus.FAILED]).toContain(h.shipment.status);
    if (h.shipment.status === ShipmentStatus.FAILED) expect(h.order.status).toBe(OrderStatus.PROCESSING);
    else expect(h.events).toHaveLength(1);
  });

  it('refuses an AWB different from the one the courier already issued, and changes nothing', async () => {
    const h = await parkedAfterPersistFailure('paxel');
    await expect(h.service.reconcileBooking('o1', { outcome: 'booked', trackingNumber: AWB_2.paxel }))
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
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE })).rejects.toBeInstanceOf(ConflictException);
      expect(h.shipment.status).toBe(status);
    }
  });

  describe('not_booked never reopens booking without evidence', () => {
    it.each([
      ['no confirmation at all', {}],
      ['a reference without the confirmation', { courierCheckReference: 'CS ticket #48213' }],
      ['the confirmation without a reference', { confirmNoActiveBooking: true }],
      ['a blank reference', { confirmNoActiveBooking: true, courierCheckReference: '  ' }],
    ])('after a timeout, refuses %s - a timeout is not evidence nothing was booked', async (_label, evidence) => {
      const h = await parkedAfterTimeout('paxel');
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked', ...evidence })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
      expect(retryOffered(h.shipment.status)).toBe(false);
    });

    it('refuses while the courier is KNOWN to hold an AWB, until it was cancelled at the courier', async () => {
      const h = await parkedAfterPersistFailure('paxel');
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE })).rejects.toBeInstanceOf(BadRequestException);
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);

      const outcome = await h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE, cancelledAtCourier: true }, 'ops@masular.test');
      expect(outcome).toMatchObject({ ok: true, status: ShipmentStatus.FAILED });
      expect(h.shipment.metadata?.booking?.reconciliation).toMatchObject({
        outcome: 'not_booked', cancelledAtCourier: true, cancelledTrackingNumber: AWB.paxel, courierCheckReference: 'CS ticket #48213',
      });
      expect(h.shipment.metadata?.booking?.unrecorded?.trackingNumber).toBe(AWB.paxel); // history kept
    });

    it.each([
      ['jne', 'JNE', AWB.jne, AWB.jne],
      ['paxel', 'PAXEL', 'BMS-20261121-RECOVER1', 'integration log'],
    ] as const)('%s: when every recovery write failed, the accepted create in the integration log still blocks it', async (courier, provider, correlationId, shown) => {
      // The courier accepted; the AWB never reached Shipment.metadata.
      const h = harness(courier);
      h.provider.createShipment.mockResolvedValue(booked(courier));
      h.faults.tx = DB_DOWN();
      h.faults.shipmentUpdateMany = (data) => (data.status === ShipmentStatus.UNKNOWN || data.status === ShipmentStatus.FAILED ? DB_DOWN() : null);
      await h.service.createForOrderSafe('o1');
      h.faults.tx = null;
      h.faults.shipmentUpdateMany = () => null;
      h.age();
      await h.worker.reconcile(); // parked as interrupted, no AWB in metadata
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
      expect(h.shipment.metadata?.booking?.unrecorded).toBeUndefined();
      h.integrationLog.accepted = { provider, createdAt: new Date('2026-11-21T03:05:00Z'), correlationId };

      const refused = await h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE }).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(BadRequestException);
      expect((refused as Error).message).toContain(shown);
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);

      await h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE, cancelledAtCourier: true });
      expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
      expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    });

    it('refuses (fails closed) when the integration log cannot be read', async () => {
      const h = await parkedAfterTimeout('jne');
      h.integrationLog.fault = DB_DOWN();
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE })).rejects.toThrow('Connection terminated');
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    });

    it('refuses while the last attempt could still be in flight (inside its lease)', async () => {
      const h = harness('paxel');
      h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError('Paxel booking outcome unknown - timeout', 'paxel'));
      await h.service.createForOrderSafe('o1'); // UNKNOWN, attempt started just now
      await expect(h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE })).rejects.toBeInstanceOf(ConflictException);
      expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    });

    it('with the courier\'s confirmation, reopens booking and the retry books exactly once', async () => {
      const h = await parkedAfterTimeout('jne');
      await h.service.reconcileBooking('o1', { outcome: 'not_booked', ...EVIDENCE, note: 'JNE confirmed no CNOTE' }, 'ops@masular.test');
      expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
      expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();
      expect(h.shipment.metadata?.booking?.reconciliation).toMatchObject({ outcome: 'not_booked', courierCheckReference: 'CS ticket #48213', resolvedBy: 'ops@masular.test' });
      expect(h.shipment.metadata?.booking?.reconciliation?.cancelledAtCourier).toBeUndefined();

      h.provider.createShipment.mockResolvedValue(booked('jne'));
      const [a, b] = await Promise.all([h.service.retry('o1'), h.worker.reconcile()]);
      expect(a.ok || b.booked === 1).toBe(true);
      expect(h.provider.createShipment).toHaveBeenCalledTimes(2); // the timed-out one + exactly one retry
      expect(h.order.status).toBe(OrderStatus.SHIPPED);
    });
  });
});

// ---------------------------------------------------------------------------
describe('unchanged behaviour', () => {
  it.each(['jne', 'paxel'] as const)('%s: a normal booking records and ships once', async (courier) => {
    const h = harness(courier);
    h.provider.createShipment.mockResolvedValue(booked(courier));

    const outcome = await h.service.createForOrderSafe('o1');

    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.order).toMatchObject({ status: OrderStatus.SHIPPED, trackingNumber: AWB[courier] });
    expect(h.events).toEqual([expect.objectContaining({ status: OrderStatus.SHIPPED, note: `Shipment created (${courier})` })]);
    expect(h.outbox).toEqual([expect.objectContaining({ metadata: { source: 'shipment.auto_booking' } })]);
    expect(h.shipment.metadata).toEqual({ [courier]: { pickupDatetime: PICKUP } });
  });

  it.each(['jne', 'paxel'] as const)('%s: a definitive refusal stays FAILED and retryable; the retry books once', async (courier) => {
    const h = harness(courier);
    h.provider.createShipment.mockRejectedValueOnce(new PermanentError('provider 400: invalid destination', courier));
    const failed = await h.service.createForOrderSafe('o1');
    expect(failed).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();
    expect(retryOffered(h.shipment.status)).toBe(true);

    h.provider.createShipment.mockResolvedValue(booked(courier));
    const retried = await h.service.retry('o1');
    expect(retried).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: AWB[courier] });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(2);
  });
});
