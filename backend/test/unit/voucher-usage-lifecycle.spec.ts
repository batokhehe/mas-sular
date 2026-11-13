import { OrderStatus, PaymentStatus, ReservationStatus } from '@prisma/client';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';
import { AdminService } from '../../src/modules/admin/admin.service';

/**
 * P1.2.3 - voucher usage lifecycle, through the REAL services:
 * PaymentSettlementService.fail / .expire, AdminService.updateOrderStatus(CANCELLED)
 * and OrderCancellationService.cancelAndRestock.
 *
 * The database is an in-memory fake with transaction semantics (state snapshot on
 * begin, restored on throw), so "rolls back together" is observable here. Lock
 * ordering and real concurrency are exercised separately against PostgreSQL
 * (test/pg/voucher-lifecycle.pg.spec.ts).
 */

type State = {
  order: { id: string; status: OrderStatus; deletedAt: null };
  payment: { id: string; orderId: string; status: PaymentStatus; verifiedAt: Date | null; deletedAt: null } | null;
  usage: { orderId: string; voucherId: string; releasedAt: Date | null } | null;
  promo: { id: string; currentUsageCount: number };
  redemption: { orderId: string; userId: string } | null;
  events: string[];
  restocks: number;
};

const ACTIVE: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.PROCESSING,
  OrderStatus.PACKING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERING,
];

function fakeDb(initial: State, opts: { failRestock?: boolean } = {}) {
  let state: State = structuredClone(initial);
  const lockSql: string[] = [];

  const tx = {
    $queryRaw: jest.fn(async (sql: { strings: string[] }) => {
      lockSql.push(sql.strings.join('?'));
      return state.payment ? [{ status: state.payment.status, verifiedAt: state.payment.verifiedAt }] : [];
    }),
    payment: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const p = state.payment;
        if (!p || p.id !== where.id) return { count: 0 };
        const allowed = where.status?.in ? where.status.in.includes(p.status) : !where.status.notIn.includes(p.status);
        if (!allowed) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => structuredClone(state.payment)),
    },
    order: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== state.order.id || !where.status.in.includes(state.order.status)) return { count: 0 };
        state.order.status = data.status;
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => structuredClone(state.order)),
    },
    orderEvent: { create: jest.fn(async ({ data }: any) => void state.events.push(`event:${data.status}`)) },
    outboxEvent: { create: jest.fn(async ({ data }: any) => void state.events.push(`outbox:${data.eventName}`)) },
    inventoryReservation: { count: jest.fn(async () => 1) },
    orderItem: { findMany: jest.fn(async () => []) },
    product: { updateMany: jest.fn() },
    paymentGatewayTransaction: { updateMany: jest.fn() },
    voucherUsage: {
      findUnique: jest.fn(async () => (state.usage ? { voucherId: state.usage.voucherId } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!state.usage || state.usage.orderId !== where.orderId || state.usage.releasedAt !== null) return { count: 0 };
        state.usage.releasedAt = data.releasedAt;
        return { count: 1 };
      }),
    },
    promo: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (state.promo.id !== where.id || !(state.promo.currentUsageCount > where.currentUsageCount.gt)) return { count: 0 };
        state.promo.currentUsageCount -= data.currentUsageCount.decrement;
        return { count: 1 };
      }),
    },
    newUserVoucherRedemption: {
      deleteMany: jest.fn(async ({ where }: any) => {
        if (state.redemption && state.redemption.orderId === where.orderId) {
          state.redemption = null;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };

  const inventory = {
    releaseForOrder: jest.fn(async () => {
      if (opts.failRestock) throw new Error('inventory release failed');
      state.restocks += 1;
    }),
  };

  const prisma = {
    payment: { findUnique: jest.fn(async () => structuredClone(state.payment)) },
    // AdminService.updateOrderStatus's idempotent early return reads the order directly.
    order: { findUnique: jest.fn(async () => structuredClone(state.order)) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (err) {
        state = snapshot; // ROLLBACK
        throw err;
      }
    }),
  };

  return { prisma, tx, inventory, lockSql, get state() { return state; } };
}

const base = (over: Partial<State> = {}): State => ({
  order: { id: 'o1', status: OrderStatus.PENDING, deletedAt: null },
  payment: { id: 'pay1', orderId: 'o1', status: PaymentStatus.PENDING, verifiedAt: null, deletedAt: null },
  usage: { orderId: 'o1', voucherId: 'v1', releasedAt: null },
  promo: { id: 'v1', currentUsageCount: 5 },
  redemption: null,
  events: [],
  restocks: 0,
  ...over,
});
const newUser = (over: Partial<State> = {}) => base({ redemption: { orderId: 'o1', userId: 'user1' }, ...over });

const SYSTEM = { kind: 'SYSTEM' as const, source: 'test' };

function services(db: ReturnType<typeof fakeDb>) {
  const cancellation = new OrderCancellationService(db.inventory as any);
  const settlement = new PaymentSettlementService(db.prisma as any, undefined, undefined, cancellation);
  return { cancellation, settlement };
}

async function adminCancel(db: ReturnType<typeof fakeDb>) {
  const { cancellation } = services(db);
  const admin = new AdminService(db.prisma as never, cancellation as never);
  // getOrder() reads a full detail projection; only the current status matters here.
  jest.spyOn(admin, 'getOrder').mockResolvedValue({ status: db.state.order.status } as any);
  return admin.updateOrderStatus('o1', { status: OrderStatus.CANCELLED } as any);
}

const released = (db: ReturnType<typeof fakeDb>) => ({
  usageReleased: db.state.usage?.releasedAt !== null,
  counter: db.state.promo.currentUsageCount,
  redemptionKept: db.state.redemption !== null,
});

describe('voucher release on unpaid termination', () => {
  it.each([
    ['1. regular voucher, unpaid expiration', 'expire'],
    ['2. regular voucher, payment failure', 'fail'],
  ])('%s releases exactly one quota unit and keeps the row', async (_label, op) => {
    const db = fakeDb(base());
    const { settlement } = services(db);
    await (op === 'expire' ? settlement.expire('pay1', SYSTEM, 'expired') : settlement.fail('pay1', SYSTEM, 'failed'));
    expect(released(db)).toEqual({ usageReleased: true, counter: 4, redemptionKept: false });
    expect(db.state.usage).not.toBeNull(); // 12. historical row retained (soft release)
    expect(db.state.order.status).toBe(OrderStatus.CANCELLED);
  });

  it('3. regular voucher, admin cancellation of an unpaid order', async () => {
    const db = fakeDb(base());
    await adminCancel(db);
    expect(released(db)).toEqual({ usageReleased: true, counter: 4, redemptionKept: false });
  });

  it.each([
    ['4. New User, unpaid expiration', 'expire'],
    ['5. New User, payment failure', 'fail'],
    ['6. New User, admin cancellation', 'admin'],
  ])('%s frees the account New User redemption', async (_label, op) => {
    const db = fakeDb(newUser());
    const { settlement } = services(db);
    if (op === 'expire') await settlement.expire('pay1', SYSTEM, 'expired');
    else if (op === 'fail') await settlement.fail('pay1', SYSTEM, 'failed');
    else await adminCancel(db);
    expect(released(db)).toEqual({ usageReleased: true, counter: 4, redemptionKept: false });
    expect(db.state.usage).not.toBeNull();
  });
});

describe('exactly once', () => {
  it('7. repeated admin cancellation decrements the quota only once', async () => {
    const db = fakeDb(base());
    await adminCancel(db);
    await adminCancel(db);
    await adminCancel(db);
    expect(db.state.promo.currentUsageCount).toBe(4);
    expect(db.state.events.filter((e) => e === 'event:CANCELLED')).toHaveLength(1);
  });

  it('7b. expiry after an admin cancellation does not release again', async () => {
    const db = fakeDb(base());
    await adminCancel(db);
    const { settlement } = services(db);
    await settlement.expire('pay1', SYSTEM, 'expired'); // payment still PENDING: CAS applies, order CAS does not
    expect(db.state.promo.currentUsageCount).toBe(4);
  });

  it('15/duplicate callbacks: a replayed failure is a no-op', async () => {
    const db = fakeDb(newUser());
    const { settlement } = services(db);
    await settlement.fail('pay1', SYSTEM, 'failed');
    const replay = await settlement.fail('pay1', SYSTEM, 'failed');
    expect(replay.result).toBe('ALREADY_TERMINAL');
    expect(db.state.promo.currentUsageCount).toBe(4);
  });
});

describe('paid orders keep their voucher', () => {
  it.each([
    ['8. paid order cancelled by admin', PaymentStatus.PAID, new Date()],
    ['9. refunded order cancelled', PaymentStatus.REFUNDED, new Date()],
    ['9b. verifiedAt evidence alone counts as paid', PaymentStatus.WAITING_VERIFICATION, new Date()],
  ])('%s: no release, no decrement, redemption kept', async (_label, status, verifiedAt) => {
    const db = fakeDb(newUser({ order: { id: 'o1', status: OrderStatus.PROCESSING, deletedAt: null }, payment: { id: 'pay1', orderId: 'o1', status, verifiedAt, deletedAt: null } }));
    await adminCancel(db);
    expect(db.state.order.status).toBe(OrderStatus.CANCELLED);
    expect(released(db)).toEqual({ usageReleased: false, counter: 5, redemptionKept: true });
  });
});

describe('atomicity', () => {
  it('10. an inventory release failure rolls the voucher (and order, payment) back', async () => {
    const db = fakeDb(newUser(), { failRestock: true });
    const { settlement } = services(db);
    await expect(settlement.expire('pay1', SYSTEM, 'expired')).rejects.toThrow('inventory release failed');
    expect(db.state.payment!.status).toBe(PaymentStatus.PENDING);
    expect(db.state.order.status).toBe(OrderStatus.PENDING);
    expect(released(db)).toEqual({ usageReleased: false, counter: 5, redemptionKept: true });
  });

  it('11. a voucher release failure rolls the cancellation back', async () => {
    // Counter already 0 for an unreleased usage: an inconsistency the release refuses.
    const db = fakeDb(newUser({ promo: { id: 'v1', currentUsageCount: 0 } }));
    const { settlement } = services(db);
    await expect(settlement.fail('pay1', SYSTEM, 'failed')).rejects.toThrow(/refusing a partial release/);
    expect(db.state.payment!.status).toBe(PaymentStatus.PENDING);
    expect(db.state.order.status).toBe(OrderStatus.PENDING);
    expect(db.state.restocks).toBe(0);
    expect(released(db)).toEqual({ usageReleased: false, counter: 0, redemptionKept: true });
  });

  it('an order without a voucher cancels normally (nothing to release)', async () => {
    const db = fakeDb(base({ usage: null }));
    await adminCancel(db);
    expect(db.state.order.status).toBe(OrderStatus.CANCELLED);
    expect(db.state.promo.currentUsageCount).toBe(5);
  });
});

describe('lock order contract', () => {
  it('cancelAndRestock locks the Payment row FOR UPDATE before it flips the Order', async () => {
    const db = fakeDb(base());
    const calls: string[] = [];
    db.tx.$queryRaw.mockImplementationOnce(async (sql: any) => {
      calls.push('lock-payment');
      return [{ status: PaymentStatus.PENDING, verifiedAt: null }];
    });
    const origFlip = db.tx.order.updateMany.getMockImplementation()!;
    db.tx.order.updateMany.mockImplementation(async (args: any) => {
      calls.push('flip-order');
      return origFlip(args);
    });
    const { cancellation } = services(db);
    await db.prisma.$transaction((tx) => cancellation.cancelAndRestock(tx as any, 'o1', 'x', ReservationStatus.RELEASED));
    expect(calls).toEqual(['lock-payment', 'flip-order']);
    expect(db.lockSql).toHaveLength(0); // the once-implementation above handled the only lock
  });

  it('the lock statement targets the order Payment row with FOR UPDATE', async () => {
    const db = fakeDb(base());
    await adminCancel(db);
    expect(db.lockSql[0]).toMatch(/SELECT status, "verifiedAt" FROM "Payment" WHERE "orderId" = \? FOR UPDATE/);
  });
});
