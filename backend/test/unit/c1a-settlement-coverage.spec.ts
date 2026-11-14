import { ConflictException } from '@nestjs/common';
import { IncidentSeverity, IncidentStatus, PaymentStatus, ReservationStatus } from '@prisma/client';
import { IncidentCenterService } from '../../src/infrastructure/logging/incident-center.service';
import { InventoryCoverageError } from '../../src/modules/inventory/inventory-coverage.error';
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service';
import { InventoryReservationWorker } from '../../src/modules/inventory/inventory-reservation.worker';
import { verifyMidtransStatusResponse } from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util';
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service';
import {
  DEFAULT_BLOCKED_RETRY_BASE_MS,
  DEFAULT_BLOCKED_RETRY_MAX_MS,
  loadMidtransReconciliationConfig,
} from '../../src/modules/payments/gateway/midtrans-reconciliation.config';
import { blockedRetryDelayMs, MidtransReconciliationWorker } from '../../src/modules/payments/gateway/midtrans-reconciliation.worker';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';

/**
 * C1-a — prevent settlement without inventory commitment.
 *
 *  A. reservation expiry is coordinated with the payment row lock (H1)
 *  B. settlement validates committed coverage and fails closed
 *  C. captured-but-unsettled gateway payments leave a durable, idempotent incident
 *
 * Unit level: Prisma is replaced by doubles that model the relevant semantics
 * (CAS, rollback, advisory lock). The same guarantees against real PostgreSQL are
 * in test/integration/c1a-settlement-coverage.int-spec.ts.
 */

// The doubles below are shape-checked by the assertions, not by the compiler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The interpolated text of a Prisma.sql template. */
function sqlText(sql: Any): string {
  return String(sql?.strings?.join('?') ?? sql?.sql ?? '');
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// =========================================================== A. expiry ======

/** expireReservation over a tx double; records the order of lock / mutation calls. */
function expiryHarness(payment: { status: PaymentStatus; deletedAt?: Date | null } | null) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (sql: Any) => {
      const text = sqlText(sql);
      if (text.includes('"Payment"')) {
        calls.push('lock:payment');
        return payment ? [{ status: payment.status, deletedAt: payment.deletedAt ?? null }] : [];
      }
      calls.push('lock:productInventory');
      return [{ id: 'pi-1', stock: 10, reserved: 3 }];
    }),
    inventoryReservation: {
      updateMany: jest.fn(async () => { calls.push('reservation.cas'); return { count: 1 }; }),
      findUnique: jest.fn(async () => ({ reservedQty: 3, productId: 'p1', outletId: 'outlet-1' })),
      update: jest.fn(async () => ({})),
    },
    productInventory: {
      findUnique: jest.fn(async () => ({ id: 'pi-1' })),
      update: jest.fn(async () => { calls.push('productInventory.update'); return {}; }),
    },
    inventoryReservationHistory: { create: jest.fn(async () => ({})) },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)) };
  const service = new InventoryReservationService(prisma as Any);
  return { service, tx, calls };
}

describe('C1-a A — reservation expiry is coordinated with the payment', () => {
  it('(1) skips a reservation whose payment is PENDING', async () => {
    const h = expiryHarness({ status: PaymentStatus.PENDING });
    await expect(h.service.expireReservation('res-1')).resolves.toBe(false);
    expect(h.tx.inventoryReservation.updateMany).not.toHaveBeenCalled();
    expect(h.tx.productInventory.update).not.toHaveBeenCalled();
    expect(h.tx.inventoryReservationHistory.create).not.toHaveBeenCalled();
  });

  it('(2) skips a reservation whose payment is WAITING_VERIFICATION (H1: uploaded receipt not yet verified)', async () => {
    const h = expiryHarness({ status: PaymentStatus.WAITING_VERIFICATION });
    await expect(h.service.expireReservation('res-1')).resolves.toBe(false);
    expect(h.tx.inventoryReservation.updateMany).not.toHaveBeenCalled();
    expect(h.tx.productInventory.update).not.toHaveBeenCalled();
  });

  it.each([PaymentStatus.FAILED, PaymentStatus.EXPIRED, PaymentStatus.REFUNDED, PaymentStatus.PAID])(
    '(3) proceeds for a terminal %s payment (safety net)',
    async (status) => {
      const h = expiryHarness({ status });
      await expect(h.service.expireReservation('res-1')).resolves.toBe(true);
      expect(h.tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
        where: { id: 'res-1', status: ReservationStatus.RESERVED },
        data: { status: ReservationStatus.EXPIRED },
      });
      // the per-outlet hold is released exactly as before
      expect(h.tx.productInventory.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'pi-1' }, data: expect.objectContaining({ reserved: { decrement: 3 } }),
      }));
    },
  );

  it('(3b) proceeds when the payment row is soft-deleted (it can never settle)', async () => {
    const h = expiryHarness({ status: PaymentStatus.PENDING, deletedAt: new Date() });
    await expect(h.service.expireReservation('res-1')).resolves.toBe(true);
  });

  it('(4) expires an orphan reservation (no payment row)', async () => {
    const h = expiryHarness(null);
    await expect(h.service.expireReservation('res-1')).resolves.toBe(true);
    expect(h.tx.inventoryReservation.updateMany).toHaveBeenCalledTimes(1);
  });

  it('(5) acquires the payment row lock BEFORE mutating the reservation or inventory', async () => {
    const h = expiryHarness({ status: PaymentStatus.EXPIRED });
    await h.service.expireReservation('res-1');

    expect(h.calls).toEqual(['lock:payment', 'reservation.cas', 'lock:productInventory', 'productInventory.update']);
    const lockSql = sqlText(h.tx.$queryRaw.mock.calls[0][0]);
    expect(lockSql).toContain('"Payment"');
    expect(lockSql).toMatch(/FOR UPDATE OF p/);
    // keyed by the reservation id that is about to be expired
    expect((h.tx.$queryRaw.mock.calls[0][0] as Any).values).toEqual(['res-1']);
  });
});

describe('C1-a A — reservation worker pre-filter', () => {
  it('(6) excludes reservations whose order still has a live PENDING / WAITING_VERIFICATION payment', async () => {
    const prisma = { inventoryReservation: { findMany: jest.fn(async () => [] as Array<{ id: string }>) } };
    const reservations = { expireReservation: jest.fn() };
    const metrics = { expired: jest.fn(), failure: jest.fn() };
    const config = { enabled: true, pollIntervalMs: 1000, initialDelayMs: 0, batchSize: 100, healthLogIntervalMs: 1000 };
    const worker = new InventoryReservationWorker(prisma as Any, reservations as Any, metrics as Any, config as Any);

    await worker.releaseExpired();

    const args = (prisma.inventoryReservation.findMany.mock.calls as Any)[0][0];
    expect(args.where.status).toBe(ReservationStatus.RESERVED);
    expect(args.where.expiresAt).toEqual(expect.objectContaining({ not: null }));
    expect(args.where.NOT).toEqual({
      order: { payment: { is: { status: { in: [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION] }, deletedAt: null } } },
    });
    // terminal / orphan / legacy rows are still selected: only the live-payment rows are excluded
    expect(JSON.stringify(args.where.NOT)).not.toMatch(/PAID|FAILED|EXPIRED|REFUNDED/);
  });
});

// =========================================================== B. coverage =====

interface Res { id: string; orderId: string; productId: string; outletId: string | null; reservedQty: number; committedQty: number; status: ReservationStatus }
interface World {
  payment: { id: string; orderId: string; amount: number; status: PaymentStatus; verifiedByUserId: string | null; deletedAt: null };
  orderStatus: string;
  reservations: Res[];
  items: Array<{ productId: string; quantity: number }>;
  products: Record<string, { stock: number }>;
  pis: Record<string, { id: string; productId: string; outletId: string; stock: number; reserved: number; available: number }>;
  outbox: string[];
  audit: number;
}

/**
 * REAL PaymentSettlementService + REAL InventoryReservationService over a stateful
 * Prisma double. `$transaction` snapshots the world and restores it on throw, i.e.
 * it models rollback, so the assertions observe committed state only.
 */
function settlementWorld(init: Partial<World> & Pick<World, 'reservations' | 'items'>) {
  let state: World = {
    payment: { id: 'pay-1', orderId: 'ord-1', amount: 40000, status: PaymentStatus.PENDING, verifiedByUserId: null, deletedAt: null },
    orderStatus: 'PENDING',
    products: {},
    pis: {},
    outbox: [],
    audit: 0,
    ...init,
  };
  const piById = (id: string) => Object.values(state.pis).find((p) => p.id === id)!;
  const match = (r: Res, where: Any) =>
    (where.id === undefined || r.id === where.id) &&
    (where.orderId === undefined || r.orderId === where.orderId) &&
    (where.status === undefined || r.status === where.status);

  const tx: Any = {
    payment: {
      updateMany: jest.fn(async ({ where, data }: Any) => {
        if (state.payment.id !== where.id || where.status.notIn.includes(state.payment.status)) return { count: 0 };
        state.payment = { ...state.payment, ...data };
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...state.payment })),
    },
    $queryRaw: jest.fn(async (sql: Any) => {
      const text = sqlText(sql);
      if (text.includes('"Order"')) return [{ status: state.orderStatus }];
      if (text.includes('"ProductInventory"')) {
        const pi = piById(sql.values[0]);
        return [{ id: pi.id, stock: pi.stock, reserved: pi.reserved }];
      }
      throw new Error(`unexpected raw SQL: ${text}`);
    }),
    order: {
      updateMany: jest.fn(async ({ where, data }: Any) => {
        if (state.orderStatus !== where.status) return { count: 0 };
        state.orderStatus = data.status;
        return { count: 1 };
      }),
    },
    orderEvent: { create: jest.fn(async () => ({})) },
    orderItem: { findMany: jest.fn(async () => state.items.map((i) => ({ ...i }))) },
    paymentGatewayTransaction: { updateMany: jest.fn(async () => ({ count: 1 })) },
    auditLog: { create: jest.fn(async () => { state.audit += 1; return {}; }) },
    outboxEvent: { create: jest.fn(async ({ data }: Any) => { state.outbox.push(data.eventName); return {}; }) },
    inventoryReservation: {
      findMany: jest.fn(async ({ where }: Any) => state.reservations.filter((r) => match(r, where)).map((r) => ({ ...r }))),
      updateMany: jest.fn(async ({ where, data }: Any) => {
        const hit = state.reservations.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    inventoryReservationHistory: { create: jest.fn(async () => ({})) },
    product: {
      update: jest.fn(async ({ where, data }: Any) => {
        state.products[where.id].stock -= data.stock.decrement;
        return {};
      }),
    },
    productInventory: {
      findUnique: jest.fn(async ({ where }: Any) => {
        const pi = state.pis[`${where.productId_outletId.productId}|${where.productId_outletId.outletId}`];
        return pi ? { id: pi.id } : null;
      }),
      update: jest.fn(async ({ where, data }: Any) => {
        const pi = piById(where.id);
        if (data.stock?.decrement) pi.stock -= data.stock.decrement;
        if (data.reserved?.decrement) pi.reserved -= data.reserved.decrement;
        if (typeof data.available === 'number') pi.available = data.available;
        return {};
      }),
    },
  };
  const prisma: Any = {
    payment: { findUnique: jest.fn(async () => ({ ...state.payment })) },
    $transaction: jest.fn(async (fn: (t: Any) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (err) {
        state = snapshot; // ROLLBACK: nothing written inside survives
        throw err;
      }
    }),
  };
  const inventory = new InventoryReservationService(prisma);
  const shipments = { createForOrderSafe: jest.fn(async () => undefined) };
  const settlement = new PaymentSettlementService(prisma, shipments as Any, inventory);
  return { settlement, inventory, shipments, tx, get state() { return state; } };
}

const res = (over: Partial<Res> & Pick<Res, 'id' | 'productId' | 'reservedQty'>): Res => ({
  orderId: 'ord-1', outletId: null, committedQty: 0, status: ReservationStatus.RESERVED, ...over,
});
const ADMIN = { kind: 'ADMIN' as const, adminId: 'admin-1' };

describe('C1-a B — settlement validates committed reservation coverage', () => {
  it('(7) rejects PARTIAL coverage: one product committed, another reservation already EXPIRED', async () => {
    const w = settlementWorld({
      reservations: [
        res({ id: 'r1', productId: 'p1', reservedQty: 2 }),
        res({ id: 'r2', productId: 'p2', reservedQty: 1, status: ReservationStatus.EXPIRED }),
      ],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      products: { p1: { stock: 10 }, p2: { stock: 10 } },
    });

    const err = await w.settlement.settle('pay-1', ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(InventoryCoverageError);
    expect((err as InventoryCoverageError).shortfalls).toEqual([{ productId: 'p2', required: 1, committed: 0 }]);
    expect(w.state.payment.status).toBe(PaymentStatus.PENDING);
  });

  it('(7b) rejects a partially committed quantity for a single product', async () => {
    const w = settlementWorld({
      reservations: [res({ id: 'r1', productId: 'p1', reservedQty: 2 })],
      items: [{ productId: 'p1', quantity: 3 }], // ordered 3, only 2 reserved
      products: { p1: { stock: 10 } },
    });
    const err = await w.settlement.settle('pay-1', ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(InventoryCoverageError);
    expect((err as InventoryCoverageError).shortfalls).toEqual([{ productId: 'p1', required: 3, committed: 2 }]);
  });

  it('(8) rejects ZERO committed coverage when reservation rows exist (H1: every row EXPIRED)', async () => {
    const w = settlementWorld({
      reservations: [
        res({ id: 'r1', productId: 'p1', reservedQty: 2, status: ReservationStatus.EXPIRED }),
        res({ id: 'r2', productId: 'p2', reservedQty: 1, status: ReservationStatus.EXPIRED }),
      ],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      products: { p1: { stock: 10 }, p2: { stock: 10 } },
    });

    await expect(w.settlement.settle('pay-1', ADMIN)).rejects.toBeInstanceOf(InventoryCoverageError);
    expect(w.state.payment.status).toBe(PaymentStatus.PENDING); // NOT paid without stock
    expect(w.state.products).toEqual({ p1: { stock: 10 }, p2: { stock: 10 } });
    // still a ConflictException for HTTP callers (admin verify → 409)
    await expect(w.settlement.settle('pay-1', ADMIN)).rejects.toBeInstanceOf(ConflictException);
  });

  it('(9) a legacy order with ZERO reservation rows settles exactly as before', async () => {
    const w = settlementWorld({ reservations: [], items: [{ productId: 'p1', quantity: 2 }], products: { p1: { stock: 10 } } });

    await expect(w.settlement.settle('pay-1', ADMIN)).resolves.toEqual(expect.objectContaining({ result: 'SETTLED' }));
    expect(w.state.payment.status).toBe(PaymentStatus.PAID);
    expect(w.state.outbox).toEqual(['payment.paid']);
    expect(w.tx.orderItem.findMany).not.toHaveBeenCalled(); // no coverage check for legacy
    expect(w.shipments.createForOrderSafe).toHaveBeenCalledWith('ord-1');
  });

  it('(10) aggregates order items for the same product before comparing', async () => {
    // checkout writes ONE reservation per product for the summed quantity
    const covered = settlementWorld({
      reservations: [res({ id: 'r1', productId: 'p1', reservedQty: 5 })],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 3 }],
      products: { p1: { stock: 10 } },
    });
    await expect(covered.settlement.settle('pay-1', ADMIN)).resolves.toEqual(expect.objectContaining({ result: 'SETTLED' }));
    expect(covered.state.products.p1.stock).toBe(5);

    const short = settlementWorld({
      reservations: [res({ id: 'r1', productId: 'p1', reservedQty: 4 })],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p1', quantity: 3 }],
      products: { p1: { stock: 10 } },
    });
    const err = await short.settlement.settle('pay-1', ADMIN).catch((e) => e);
    expect(err).toBeInstanceOf(InventoryCoverageError);
    expect((err as InventoryCoverageError).shortfalls).toEqual([{ productId: 'p1', required: 5, committed: 4 }]);
  });

  it('(11) validates multi-outlet (ProductInventory) coverage and deducts outlet stock once', async () => {
    const pis = {
      'p1|o1': { id: 'pi-1', productId: 'p1', outletId: 'o1', stock: 10, reserved: 2, available: 8 },
      'p2|o1': { id: 'pi-2', productId: 'p2', outletId: 'o1', stock: 5, reserved: 1, available: 4 },
    };
    const w = settlementWorld({
      reservations: [
        res({ id: 'r1', productId: 'p1', outletId: 'o1', reservedQty: 2 }),
        res({ id: 'r2', productId: 'p2', outletId: 'o1', reservedQty: 1 }),
      ],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      pis: structuredClone(pis),
    });
    await expect(w.settlement.settle('pay-1', ADMIN)).resolves.toEqual(expect.objectContaining({ result: 'SETTLED' }));
    expect(w.state.pis['p1|o1']).toEqual(expect.objectContaining({ stock: 8, reserved: 0, available: 8 }));
    expect(w.state.pis['p2|o1']).toEqual(expect.objectContaining({ stock: 4, reserved: 0, available: 4 }));
    expect(w.tx.product.update).not.toHaveBeenCalled();

    // same order shape, but one outlet reservation expired before payment → refused
    const expired = settlementWorld({
      reservations: [
        res({ id: 'r1', productId: 'p1', outletId: 'o1', reservedQty: 2 }),
        res({ id: 'r2', productId: 'p2', outletId: 'o1', reservedQty: 1, status: ReservationStatus.EXPIRED }),
      ],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      pis: structuredClone(pis),
    });
    await expect(expired.settlement.settle('pay-1', ADMIN)).rejects.toBeInstanceOf(InventoryCoverageError);
    expect(expired.state.pis).toEqual(pis); // outlet stock untouched after rollback
  });

  it('(12) a coverage failure rolls back the WHOLE settlement — including reservations it had just committed', async () => {
    const w = settlementWorld({
      reservations: [
        res({ id: 'r1', productId: 'p1', reservedQty: 2 }), // committed inside the tx…
        res({ id: 'r2', productId: 'p2', reservedQty: 1, status: ReservationStatus.EXPIRED }), // …but this one is gone
      ],
      items: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      products: { p1: { stock: 10 }, p2: { stock: 10 } },
    });

    await expect(w.settlement.settle('pay-1', ADMIN)).rejects.toBeInstanceOf(InventoryCoverageError);

    // inside the tx the commit DID happen (the guard runs after it)…
    expect(w.tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { decrement: 2 } } });
    // …and all of it was rolled back:
    expect(w.state.payment.status).toBe(PaymentStatus.PENDING);
    expect(w.state.orderStatus).toBe('PENDING');
    expect(w.state.reservations.map((r) => [r.id, r.status, r.committedQty])).toEqual([
      ['r1', ReservationStatus.RESERVED, 0],
      ['r2', ReservationStatus.EXPIRED, 0],
    ]);
    expect(w.state.products.p1.stock).toBe(10);
    expect(w.state.outbox).toEqual([]); // no payment.paid
    expect(w.state.audit).toBe(0);
    // nothing after the guard ran, and no shipment is ever booked
    expect(w.tx.paymentGatewayTransaction.updateMany).not.toHaveBeenCalled();
    expect(w.tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(w.shipments.createForOrderSafe).not.toHaveBeenCalled();
  });
});

// =========================================================== C. incidents ====

interface IncidentRow {
  id: string; type: string; paymentId: string; orderId: string | null; status: IncidentStatus;
  severity: IncidentSeverity; count: number; lastSeen: Date; metadata: Any; title: string; source: string;
}

/**
 * Incident table double. `$executeRaw` models pg_advisory_xact_lock: a per-key
 * mutex held until the surrounding transaction ends. Every query yields to the
 * event loop, so concurrent callers genuinely interleave.
 */
function incidentDb(opts: {
  honourAdvisoryLock?: boolean;
  /** Runs right after the active-incident lookup, before the bump — models a concurrent resolve(). */
  afterLookup?: (rows: IncidentRow[]) => void;
} = {}) {
  const honour = opts.honourAdvisoryLock ?? true;
  const rows: IncidentRow[] = [];
  const locks = new Map<string, Promise<void>>();
  const lockSql: string[] = [];
  let seq = 0;

  const prisma: Any = {
    // Non-transactional reads (listActivePaymentExceptions).
    incident: {
      findMany: jest.fn(async ({ where, take }: Any) =>
        rows
          .filter((r) => r.type === where.type && where.status.in.includes(r.status) && r.paymentId != null)
          .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
          .slice(0, take)
          .map((r) => ({ paymentId: r.paymentId, count: r.count, lastSeen: r.lastSeen }))),
    },
    $transaction: jest.fn(async (fn: (tx: Any) => Promise<unknown>) => {
      const held: Array<() => void> = [];
      const tx = {
        $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          lockSql.push(strings.join('?'));
          const key = String(values[0]);
          if (!honour) return 1;
          while (locks.has(key)) await locks.get(key);
          let release!: () => void;
          locks.set(key, new Promise<void>((r) => { release = r; }));
          held.push(() => { locks.delete(key); release(); });
          return 1;
        }),
        incident: {
          findFirst: jest.fn(async ({ where }: Any) => {
            await flush();
            const hit = rows
              .filter((r) => r.type === where.type && r.paymentId === where.paymentId && where.status.in.includes(r.status))
              .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0];
            opts.afterLookup?.(rows);
            return hit ? { id: hit.id, severity: hit.severity } : null;
          }),
          // Conditional bump: like PostgreSQL, the predicate is evaluated against the
          // row as it is NOW (after any concurrent resolve committed).
          updateMany: jest.fn(async ({ where, data }: Any) => {
            await flush();
            const r = rows.find((x) => x.id === where.id && where.status.in.includes(x.status));
            if (!r) return { count: 0 };
            r.count += data.count.increment;
            r.lastSeen = data.lastSeen;
            r.metadata = data.metadata;
            if (data.severity) r.severity = data.severity;
            return { count: 1 };
          }),
          create: jest.fn(async ({ data }: Any) => {
            await flush();
            const r: IncidentRow = { id: `inc-${++seq}`, status: IncidentStatus.OPEN, count: 1, ...data, lastSeen: data.lastSeen ?? new Date() };
            rows.push(r);
            return { id: r.id };
          }),
        },
      };
      try {
        return await fn(tx);
      } finally {
        held.forEach((release) => release()); // xact lock released at commit/rollback
      }
    }),
  };
  const cache = { get: jest.fn(), set: jest.fn() };
  const service = new IncidentCenterService(prisma, cache as Any);
  return { service, rows, lockSql, prisma };
}

const PROVIDER_ORDER_ID = 'BMS-20260810-001-aaaaaaaa';
const AMOUNT = 40000;
const verified = (() => {
  const v = verifyMidtransStatusResponse({
    order_id: PROVIDER_ORDER_ID, transaction_status: 'settlement', status_code: '200',
    gross_amount: '40000.00', transaction_id: 'trx-1',
  }, PROVIDER_ORDER_ID, AMOUNT);
  if (!v.ok) throw new Error('fixture not verifiable');
  return v;
})();
const gtx = { id: 'gtx-1', paymentId: 'pay-1', provider: 'midtrans', providerOrderId: PROVIDER_ORDER_ID, providerTransactionId: null, grossAmount: AMOUNT };

function applierWith(settleError: Error, current: { status: PaymentStatus; orderId: string } | null, db = incidentDb()) {
  const settlement = {
    settle: jest.fn(async () => { throw settleError; }),
    currentState: jest.fn(async () => current),
  };
  const logs = { write: jest.fn() };
  const applier = new GatewayStatusApplier(settlement as Any, logs as Any, db.service);
  const apply = (source = 'payments.webhook.midtrans') => applier.apply({ transaction: gtx as Any, verified, source });
  return { applier, apply, settlement, logs, db };
}

const coverageError = () => new InventoryCoverageError('ord-1', [{ productId: 'p1', required: 2, committed: 0 }]);

describe('C1-a C — durable incidents for captured-but-unsettled gateway payments', () => {
  it('(13) a captured payment blocked by coverage creates ONE durable incident with safe metadata', async () => {
    const h = applierWith(coverageError(), { status: PaymentStatus.PENDING, orderId: 'ord-1' });

    await expect(h.apply()).resolves.toBe('illegal_transition');

    expect(h.db.rows).toHaveLength(1);
    const inc = h.db.rows[0];
    expect(inc).toEqual(expect.objectContaining({
      type: 'payment.settlement_inventory_conflict', paymentId: 'pay-1', orderId: 'ord-1',
      status: IncidentStatus.OPEN, severity: IncidentSeverity.HIGH, count: 1, source: 'payments.webhook.midtrans',
    }));
    expect(Object.keys(inc.metadata).sort()).toEqual([
      'gatewayTransactionId', 'orderId', 'paymentId', 'paymentStatus', 'provider', 'providerOrderId',
      'providerStatus', 'providerTransactionId', 'reason', 'shortfalls', 'source',
    ]);
    expect(JSON.stringify(inc.metadata)).not.toMatch(/server.?key|signature|authorization|token|password|secret/i);
  });

  it('(13b) any other refusal of captured money (e.g. payment already EXPIRED) is payment.captured_not_settled', async () => {
    const h = applierWith(new ConflictException('Payment cannot be verified from terminal status EXPIRED'), { status: PaymentStatus.EXPIRED, orderId: 'ord-1' });
    await expect(h.apply()).resolves.toBe('illegal_transition');
    expect(h.db.rows.map((r) => r.type)).toEqual(['payment.captured_not_settled']);
  });

  it('(13c) a lost settle race (payment is in fact PAID) is NOT an incident', async () => {
    const h = applierWith(new ConflictException('Payment already verified or rejected'), { status: PaymentStatus.PAID, orderId: 'ord-1' });
    await expect(h.apply()).resolves.toBe('illegal_transition');
    expect(h.db.rows).toEqual([]);
  });

  it('(13d) if the incident cannot be written, the notification stays retryable (error propagates)', async () => {
    const db = incidentDb();
    db.prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    const h = applierWith(coverageError(), { status: PaymentStatus.PENDING, orderId: 'ord-1' }, db);
    await expect(h.apply()).rejects.toThrow('db down');
  });

  it('(14) repeated gateway callbacks / reconciliation passes bump ONE active incident', async () => {
    const h = applierWith(coverageError(), { status: PaymentStatus.PENDING, orderId: 'ord-1' });

    await h.apply('payments.webhook.midtrans');
    await h.apply('payments.webhook.midtrans');
    await h.apply('payments.reconciliation.midtrans');

    expect(h.db.rows).toHaveLength(1);
    expect(h.db.rows[0].count).toBe(3);
    expect(h.db.rows[0].metadata.source).toBe('payments.reconciliation.midtrans'); // refreshed
  });

  it('(15) concurrent incident writes for the same payment are idempotent (advisory-locked)', async () => {
    const db = incidentDb();
    const input = {
      type: 'payment.captured_not_settled' as const, paymentId: 'pay-1', orderId: 'ord-1',
      severity: IncidentSeverity.HIGH, title: 't', description: 'd', source: 's',
    };
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => db.service.recordPaymentException(input)));

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].count).toBe(6);
    expect(outcomes.filter((o) => o.outcome === 'CREATED')).toHaveLength(1);
    expect(db.lockSql[0]).toMatch(/pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)/);

    // different payment → different key → its own incident
    await db.service.recordPaymentException({ ...input, paymentId: 'pay-2' });
    expect(db.rows).toHaveLength(2);

    // negative control: the SAME interleaving without the lock does duplicate,
    // so the assertion above is really exercising the lock
    const unlocked = incidentDb({ honourAdvisoryLock: false });
    await Promise.all(Array.from({ length: 6 }, () => unlocked.service.recordPaymentException(input)));
    expect(unlocked.rows.length).toBeGreaterThan(1);
  });

  it('(16) a RESOLVED incident is not reused: a new occurrence opens a new incident', async () => {
    const h = applierWith(coverageError(), { status: PaymentStatus.PENDING, orderId: 'ord-1' });
    await h.apply();
    h.db.rows[0].status = IncidentStatus.RESOLVED; // operator resolved it

    await h.apply();

    expect(h.db.rows).toHaveLength(2);
    expect(h.db.rows[0]).toEqual(expect.objectContaining({ status: IncidentStatus.RESOLVED, count: 1 }));
    expect(h.db.rows[1]).toEqual(expect.objectContaining({ status: IncidentStatus.OPEN, count: 1, type: 'payment.settlement_inventory_conflict' }));

    // and an ACKNOWLEDGED one is still active → bumped, not duplicated
    h.db.rows[1].status = IncidentStatus.ACKNOWLEDGED;
    await h.apply();
    expect(h.db.rows).toHaveLength(2);
    expect(h.db.rows[1].count).toBe(2);
  });

  it('the sweep\'s per-type dedup is untouched: payment incidents are keyed by paymentId too', async () => {
    const db = incidentDb();
    const base = { type: 'payment.captured_not_settled' as const, severity: IncidentSeverity.HIGH, title: 't', description: 'd', source: 's' };
    await db.service.recordPaymentException({ ...base, paymentId: 'pay-1' });
    await db.service.recordPaymentException({ ...base, paymentId: 'pay-2' });
    expect(db.rows.map((r) => r.paymentId)).toEqual(['pay-1', 'pay-2']);
  });
});

// ======================================================= C1-a.1 R3-a =========

describe('C1-a.1 R3-a — a concurrent resolve never absorbs a new occurrence', () => {
  const input = {
    type: 'payment.settlement_inventory_conflict' as const, paymentId: 'pay-1', orderId: 'ord-1',
    severity: IncidentSeverity.HIGH, title: 't', description: 'd', source: 's',
  };

  it('(R1) bumps an ACTIVE incident in place with a status-conditional update', async () => {
    const db = incidentDb();
    const first = await db.service.recordPaymentException(input);
    const second = await db.service.recordPaymentException(input);

    expect(first.outcome).toBe('CREATED');
    expect(second).toEqual({ id: first.id, outcome: 'UPDATED' });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].count).toBe(2);
  });

  it('(R2) an incident resolved between lookup and update is NOT bumped', async () => {
    let armed = false;
    const db = incidentDb({
      afterLookup: (rows) => {
        if (!armed) return;
        armed = false;
        rows[0].status = IncidentStatus.RESOLVED; // operator resolves it right now
      },
    });
    await db.service.recordPaymentException(input);
    const before = structuredClone(db.rows[0]);

    armed = true;
    await db.service.recordPaymentException(input);

    expect(db.rows[0]).toEqual({ ...before, status: IncidentStatus.RESOLVED }); // count, lastSeen, metadata untouched
  });

  it('(R3) the zero-row conditional update falls through to a NEW active incident, which then dedups normally', async () => {
    let armed = false;
    const db = incidentDb({
      afterLookup: (rows) => {
        if (!armed) return;
        armed = false;
        rows[0].status = IncidentStatus.RESOLVED;
      },
    });
    const first = await db.service.recordPaymentException(input);
    armed = true;
    const second = await db.service.recordPaymentException(input);
    const third = await db.service.recordPaymentException(input);

    expect(second.outcome).toBe('CREATED');
    expect(second.id).not.toBe(first.id);
    expect(third).toEqual({ id: second.id, outcome: 'UPDATED' });
    expect(db.rows.map((r) => [r.status, r.count])).toEqual([
      [IncidentStatus.RESOLVED, 1],
      [IncidentStatus.OPEN, 2],
    ]);
  });

  it('(R4) concurrent calls with a resolve in the middle: exactly one ACTIVE incident, no occurrence lost', async () => {
    let lookups = 0;
    const db = incidentDb({
      afterLookup: (rows) => {
        lookups += 1;
        if (lookups === 3) rows.forEach((r) => { r.status = IncidentStatus.RESOLVED; });
      },
    });
    await Promise.all(Array.from({ length: 6 }, () => db.service.recordPaymentException(input)));

    const active = db.rows.filter((r) => r.status !== IncidentStatus.RESOLVED);
    expect(active).toHaveLength(1);
    expect(db.rows.reduce((sum, r) => sum + r.count, 0)).toBe(6); // every occurrence counted somewhere
    // calls serialize on the advisory lock: #1 creates, #2 bumps, #3 sees it resolved
    // mid-way → must NOT bump it → creates a new one, which #4–#6 bump
    expect(db.rows.map((r) => [r.status, r.count])).toEqual([
      [IncidentStatus.RESOLVED, 2],
      [IncidentStatus.OPEN, 4],
    ]);
  });

  it('(R5) an existing RESOLVED incident is preserved unchanged when a new occurrence arrives', async () => {
    const db = incidentDb();
    const resolved: IncidentRow = {
      id: 'inc-old', type: input.type, paymentId: 'pay-1', orderId: 'ord-1', status: IncidentStatus.RESOLVED,
      severity: IncidentSeverity.HIGH, count: 7, lastSeen: new Date('2026-11-01T00:00:00Z'), metadata: { reason: 'old' },
      title: 'old', source: 'old',
    };
    db.rows.push(structuredClone(resolved));

    const out = await db.service.recordPaymentException(input);

    expect(out.outcome).toBe('CREATED');
    expect(db.rows[0]).toEqual(resolved);
    expect(db.rows[1]).toEqual(expect.objectContaining({ status: IncidentStatus.OPEN, count: 1 }));
  });
});

// ============================================ C1-a.1 reconciliation backoff ==

interface Cand { id: string; paymentId: string; providerOrderId: string; createdAt: Date; paymentStatus: PaymentStatus }

const cand = (i: number, over: Partial<Cand> = {}): Cand => ({
  id: `gtx-${i}`, paymentId: `pay-${i}`, providerOrderId: `BMS-${String(i).padStart(4, '0')}`,
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)), paymentStatus: PaymentStatus.PENDING, ...over,
});

/**
 * REAL MidtransReconciliationWorker + REAL GatewayStatusApplier + REAL
 * IncidentCenterService (over incidentDb). The candidate double honours the
 * worker's where / orderBy / take, so batch fairness is observed, not assumed.
 */
function reconHarness(opts: {
  cands: Cand[];
  blocked: Set<string>;
  withIncidents?: boolean;
  batchSize?: number;
}) {
  const db = incidentDb();
  const prisma = {
    paymentGatewayTransaction: {
      findMany: jest.fn(async ({ where, take }: Any) =>
        opts.cands
          .filter((c) => where.payment.status.in.includes(c.paymentStatus))
          .filter((c) => !where.paymentId || !where.paymentId.notIn.includes(c.paymentId))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, take)
          .map((c) => ({ id: c.id, paymentId: c.paymentId, provider: 'midtrans', providerOrderId: c.providerOrderId, grossAmount: AMOUNT }))),
    },
  };
  const getStatus = jest.fn(async ({ providerReference }: { providerReference: string }) => ({
    raw: {
      order_id: providerReference, transaction_status: 'settlement', status_code: '200',
      gross_amount: '40000.00', transaction_id: `trx-${providerReference}`,
    },
  }));
  const providers = { get: jest.fn(() => ({ name: 'midtrans', getStatus })) };
  const settlement = {
    settle: jest.fn(async (paymentId: string, _actor: unknown) => {
      if (opts.blocked.has(paymentId)) throw new InventoryCoverageError(`ord-${paymentId}`, [{ productId: 'p1', required: 1, committed: 0 }]);
      const c = opts.cands.find((x) => x.paymentId === paymentId)!;
      c.paymentStatus = PaymentStatus.PAID; // settled → leaves the candidate set
      return { result: 'SETTLED', payment: { id: paymentId } };
    }),
    currentState: jest.fn(async (paymentId: string) => ({ status: PaymentStatus.PENDING, orderId: `ord-${paymentId}` })),
  };
  const logs = { write: jest.fn() };
  const incidents = opts.withIncidents === false ? undefined : db.service;
  const applier = new GatewayStatusApplier(settlement as Any, logs as Any, incidents);
  const config = {
    enabled: true, pollIntervalMs: 60_000, initialDelayMs: 0, batchSize: opts.batchSize ?? 50, minAgeMs: 0,
    healthLogIntervalMs: 1e12, blockedRetryBaseMs: 15 * 60_000, blockedRetryMaxMs: 6 * 60 * 60_000,
  };
  const gateway = {
    enabled: true, serverKey: 'k', clientKey: 'c', isProduction: false,
    baseUrl: 'https://api.sandbox.midtrans.com', timeoutMs: 5000, maxRetry: 2,
  };
  const worker = new MidtransReconciliationWorker(prisma as Any, providers as Any, applier, config, gateway as Any, logs as Any, incidents);
  let now = Date.now();
  (worker as Any).nowMs = () => now;
  const setNow = (ms: number) => { now = ms; };
  const lastWhere = () => (prisma.paymentGatewayTransaction.findMany.mock.calls as Any).at(-1)[0].where;
  return { worker, prisma, getStatus, settlement, db, setNow, lastWhere, logs };
}

describe('C1-a.1 — reconciliation backoff for inventory-blocked payments', () => {
  const BASE = 15 * 60_000;

  it('config: blocked-retry defaults are 15 min base / 6 h cap and env-overridable', () => {
    const d = loadMidtransReconciliationConfig({});
    expect(d.blockedRetryBaseMs).toBe(DEFAULT_BLOCKED_RETRY_BASE_MS);
    expect(d.blockedRetryBaseMs).toBe(15 * 60_000);
    expect(d.blockedRetryMaxMs).toBe(DEFAULT_BLOCKED_RETRY_MAX_MS);
    expect(d.blockedRetryMaxMs).toBe(6 * 60 * 60_000);
    const o = loadMidtransReconciliationConfig({
      MIDTRANS_RECONCILIATION_BLOCKED_RETRY_BASE_MS: '1000', MIDTRANS_RECONCILIATION_BLOCKED_RETRY_MAX_MS: '5000',
    });
    expect([o.blockedRetryBaseMs, o.blockedRetryMaxMs]).toEqual([1000, 5000]);
  });

  it('backoff doubles per recorded occurrence and is capped', () => {
    const max = 6 * 60 * 60_000;
    expect([0, 1, 2, 3, 4].map((n) => blockedRetryDelayMs(n, BASE, max))).toEqual([BASE, BASE, 2 * BASE, 4 * BASE, 8 * BASE]);
    expect(blockedRetryDelayMs(6, BASE, max)).toBe(max); // 32 × 15 min > 6 h
    expect(blockedRetryDelayMs(10_000, BASE, max)).toBe(max); // no overflow
  });

  it('without an IncidentCenter the candidate query is exactly as before', async () => {
    const h = reconHarness({ cands: [cand(1)], blocked: new Set(), withIncidents: false });
    const tick = await h.worker.reconcile();
    expect(h.lastWhere()).not.toHaveProperty('paymentId');
    expect(tick).toEqual({ scanned: 1, transitioned: 1, unchanged: 0, failed: 0, deferred: 0 });
  });

  it('a blocked payment inside its backoff window is excluded BEFORE take; other incident types never defer', async () => {
    const h = reconHarness({ cands: [cand(1), cand(2)], blocked: new Set(['pay-1']) });
    await h.worker.reconcile(); // pay-1 blocked → incident; pay-2 settles

    // an unrelated captured_not_settled incident for another payment must not defer it
    await h.db.service.recordPaymentException({
      type: 'payment.captured_not_settled', paymentId: 'pay-3', severity: IncidentSeverity.HIGH, title: 't', description: 'd', source: 's',
    });
    const tick = await h.worker.reconcile();

    expect(h.lastWhere().paymentId).toEqual({ notIn: ['pay-1'] });
    expect(h.lastWhere().payment.status).toEqual({ in: [PaymentStatus.PENDING, PaymentStatus.WAITING_VERIFICATION] }); // unchanged
    expect(tick).toEqual(expect.objectContaining({ scanned: 0, deferred: 1 }));
  });

  it('fairness: 50 oldest blocked payments no longer starve newer charges (with negative control)', async () => {
    const make = () => Array.from({ length: 55 }, (_, i) => cand(i));
    const blockedIds = new Set(Array.from({ length: 50 }, (_, i) => `pay-${i}`));

    const fixed = reconHarness({ cands: make(), blocked: blockedIds });
    const t1 = await fixed.worker.reconcile();
    expect(t1).toEqual(expect.objectContaining({ scanned: 50, transitioned: 0, deferred: 0 }));
    const t2 = await fixed.worker.reconcile();
    expect(t2).toEqual(expect.objectContaining({ scanned: 5, transitioned: 5, deferred: 50 }));
    expect(fixed.db.rows).toHaveLength(50); // one incident per blocked payment, none duplicated

    // negative control: the previous behaviour re-scans the same 50 every tick
    const old = reconHarness({ cands: make(), blocked: blockedIds, withIncidents: false });
    await old.worker.reconcile();
    const o2 = await old.worker.reconcile();
    expect(o2).toEqual(expect.objectContaining({ scanned: 50, transitioned: 0 }));
  });

  it('retries after the backoff elapses, then exponentially later — one incident throughout', async () => {
    const h = reconHarness({ cands: [cand(1)], blocked: new Set(['pay-1']) });
    await h.worker.reconcile();
    expect(h.db.rows).toHaveLength(1);
    const l1 = h.db.rows[0].lastSeen.getTime();

    h.setNow(l1 + BASE - 1);
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ scanned: 0, deferred: 1 }));
    h.setNow(l1 + BASE);
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ scanned: 1, deferred: 0 }));
    expect(h.db.rows[0].count).toBe(2);

    const l2 = h.db.rows[0].lastSeen.getTime();
    h.setNow(l2 + 2 * BASE - 1);
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ scanned: 0, deferred: 1 }));
    h.setNow(l2 + 2 * BASE);
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ scanned: 1 }));

    expect(h.db.rows).toHaveLength(1);
    expect(h.db.rows[0]).toEqual(expect.objectContaining({ status: IncidentStatus.OPEN, count: 3 }));
    expect(h.getStatus).toHaveBeenCalledTimes(3); // not once per tick
  });

  it('transient errors keep the existing every-tick retry and never defer', async () => {
    const h = reconHarness({ cands: [cand(1)], blocked: new Set() });
    h.getStatus.mockRejectedValue(new Error('timeout'));

    expect(await h.worker.reconcile()).toEqual({ scanned: 1, transitioned: 0, unchanged: 0, failed: 1, deferred: 0 });
    expect(await h.worker.reconcile()).toEqual({ scanned: 1, transitioned: 0, unchanged: 0, failed: 1, deferred: 0 });
    expect(h.db.rows).toEqual([]); // no incident for a transient failure
    expect(h.lastWhere()).not.toHaveProperty('paymentId');
  });

  it('a failing deferral lookup fails OPEN (old behaviour), never blocks reconciliation', async () => {
    const h = reconHarness({ cands: [cand(1)], blocked: new Set() });
    jest.spyOn(h.db.service, 'listActivePaymentExceptions').mockRejectedValueOnce(new Error('db blip'));
    const tick = await h.worker.reconcile();
    expect(tick).toEqual(expect.objectContaining({ scanned: 1, transitioned: 1, deferred: 0 }));
    expect(h.lastWhere()).not.toHaveProperty('paymentId');
  });

  it('a failing deferral lookup emits ONE structured warning per tick — class and code only, never the message', async () => {
    const h = reconHarness({ cands: [cand(1), cand(2), cand(3)], blocked: new Set() });
    const leaky = Object.assign(new Error("Can't reach postgresql://app:hunter2@db:5432 (token=abc)"), { name: 'PrismaClientInitializationError', code: 'P1001' });
    jest.spyOn(h.db.service, 'listActivePaymentExceptions').mockRejectedValueOnce(leaky);

    const tick = await h.worker.reconcile();

    expect(tick).toEqual(expect.objectContaining({ scanned: 3, transitioned: 3, deferred: 0 })); // fallback unchanged
    const warnings = (h.logs.write.mock.calls as Any).map((c: Any) => c[0]).filter((e: Any) => e.action === 'deferral.lookup_failed');
    expect(warnings).toEqual([{
      level: 'WARN',
      module: 'worker.midtrans-reconciliation',
      action: 'deferral.lookup_failed',
      message: 'blocked-payment backoff lookup failed; reconciling without deferral this tick',
      metadata: {
        incidentType: 'payment.settlement_inventory_conflict',
        errorClass: 'PrismaClientInitializationError',
        errorCode: 'P1001',
        fallback: 'no_deferral',
      },
    }]); // once per tick, not once per candidate
    expect(JSON.stringify(h.logs.write.mock.calls)).not.toMatch(/hunter2|postgresql:\/\/|token=/);

    // a later healthy tick writes no warning and backoff semantics are untouched
    h.logs.write.mockClear();
    await h.worker.reconcile();
    expect((h.logs.write.mock.calls as Any).some((c: Any) => c[0].action === 'deferral.lookup_failed')).toBe(false);
  });

  it('a non-Error rejection is still reported safely (unknown class, no code)', async () => {
    const h = reconHarness({ cands: [cand(1)], blocked: new Set() });
    jest.spyOn(h.db.service, 'listActivePaymentExceptions').mockRejectedValueOnce('boom');
    await h.worker.reconcile();
    const w = (h.logs.write.mock.calls as Any).map((c: Any) => c[0]).find((e: Any) => e.action === 'deferral.lookup_failed');
    expect(w.metadata).toEqual(expect.objectContaining({ errorClass: 'unknown', errorCode: null }));
  });

  it('recovery: resolving the incident lets the very next tick retry; once fixed it settles, no new incident', async () => {
    const blocked = new Set(['pay-1']);
    const h = reconHarness({ cands: [cand(1)], blocked });
    await h.worker.reconcile();
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ deferred: 1, scanned: 0 }));

    // operator fixes the inventory problem, then resolves the incident ("retry now")
    blocked.delete('pay-1');
    h.db.rows[0].status = IncidentStatus.RESOLVED;

    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ scanned: 1, transitioned: 1, deferred: 0 }));
    expect(h.settlement.settle).toHaveBeenLastCalledWith('pay-1', expect.objectContaining({ kind: 'GATEWAY' }));
    expect(h.db.rows).toHaveLength(1); // resolved incident kept as history, nothing new opened
  });

  it('resolving WITHOUT fixing re-opens a fresh incident and restarts the backoff (never silently settled)', async () => {
    const cands = [cand(1)];
    const h = reconHarness({ cands, blocked: new Set(['pay-1']) });
    await h.worker.reconcile();
    h.db.rows[0].status = IncidentStatus.RESOLVED;

    await h.worker.reconcile();

    expect(h.db.rows.map((r) => [r.status, r.count])).toEqual([[IncidentStatus.RESOLVED, 1], [IncidentStatus.OPEN, 1]]);
    expect(h.settlement.settle).toHaveBeenCalledTimes(2);
    expect(cands[0].paymentStatus).toBe(PaymentStatus.PENDING); // still unsettled
    expect(await h.worker.reconcile()).toEqual(expect.objectContaining({ deferred: 1, scanned: 0 })); // backoff restarted
  });

  it('payment expiry: an expired payment leaves the candidate set; its incident stays visible', async () => {
    const cands = [cand(1)];
    const h = reconHarness({ cands, blocked: new Set(['pay-1']) });
    await h.worker.reconcile();
    cands[0].paymentStatus = PaymentStatus.EXPIRED; // lifecycle worker expired it (unchanged policy)

    h.setNow(h.db.rows[0].lastSeen.getTime() + 10 * BASE); // backoff long elapsed
    const tick = await h.worker.reconcile();

    expect(tick).toEqual(expect.objectContaining({ scanned: 0 }));
    expect(h.db.rows).toEqual([expect.objectContaining({ status: IncidentStatus.OPEN, count: 1, paymentId: 'pay-1' })]);
  });
});
