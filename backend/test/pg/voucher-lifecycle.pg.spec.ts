import { randomUUID } from 'crypto';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma, PrismaClient, ReservationStatus, VoucherType } from '@prisma/client';
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service';
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service';
import { AdminService } from '../../src/modules/admin/admin.service';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * P1.2.3 - voucher lifecycle concurrency against REAL PostgreSQL row locks.
 *
 * OPT-IN: runs only when VOUCHER_PG_URL points at a THROWAWAY database that has all
 * migrations applied (never the shared dev database, never production). Without it
 * the suite is skipped, so default `jest` runs are unaffected.
 *
 *   VOUCHER_PG_URL=postgresql://user:pass@127.0.0.1:<port>/<db> npx jest test/pg
 *
 * Interleavings are forced, not hoped for: harness wrappers add pg_sleep INSIDE the
 * real transactions (after the real service code has taken its locks), and the
 * competing operation starts while that transaction is still open.
 */
const URL = process.env.VOUCHER_PG_URL;
const suite = URL ? describe : describe.skip;

jest.setTimeout(60_000);

const HOLD_SECONDS = 0.8;
const START_DELAY_MS = 150;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('voucher lifecycle on PostgreSQL (P1.2.3)', () => {
  let prisma: PrismaClient;
  let categoryId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    await prisma.$connect();
    const c = randomUUID().slice(0, 8);
    categoryId = (await prisma.category.create({ data: { name: `Cat ${c}`, slug: `cat-${c}` } })).id;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // pg_sleep returns void, which $queryRaw cannot deserialize; $executeRaw runs it as a statement.
  const sleepIn = (tx: Prisma.TransactionClient) => tx.$executeRaw`SELECT pg_sleep(${HOLD_SECONDS})`;

  /** A cancellation whose transaction stays open (locks held) after the real cancel ran. */
  class HoldingCancellation extends OrderCancellationService {
    override async cancelAndRestock(tx: Prisma.TransactionClient, orderId: string, note: string, status?: ReservationStatus) {
      const out = await super.cancelAndRestock(tx, orderId, note, status);
      await sleepIn(tx);
      return out;
    }
  }
  /** Settlement whose transaction stays open after the payment flip + order lock (via commitForOrder). */
  const holdingInventory = {
    commitForOrder: async (tx: Prisma.TransactionClient) => (await sleepIn(tx), 0),
    // C1-a B guard: stubbed with the inventory double — coverage is not under test here.
    assertCommittedCoverage: async () => ({ mode: 'LEGACY_NO_RESERVATIONS' as const }),
  };

  type Seed = { userId: string; orderId: string; paymentId: string; promoId: string; productId: string };

  async function seed(opts: { newUser?: boolean; counter?: number; promoId?: string } = {}): Promise<Seed> {
    const s = randomUUID().slice(0, 8);
    const userId = `u-${s}`;
    const promoId = opts.promoId ?? `promo-${s}`;
    const productId = `prod-${s}`;
    await prisma.user.create({ data: { id: userId, email: `${s}@example.test`, name: 'T' } });
    const address = await prisma.address.create({
      data: { userId, label: 'home', recipientName: 'R', phone: '6280000000000', fullAddress: 'a', latitude: 0, longitude: 0 },
    });
    if (!opts.promoId) {
      await prisma.promo.create({
        data: {
          id: promoId, code: `P-${s}`, title: 't', description: 'd', voucherType: VoucherType.PERCENTAGE_DISCOUNT,
          discountPercentage: 10, isNewUserOnly: !!opts.newUser, currentUsageCount: opts.counter ?? 5,
        },
      });
    }
    await prisma.product.create({ data: { id: productId, name: `Product ${s}`, slug: `product-${s}`, description: 'd', imageUrl: 'x', categoryId, price: 10000, stock: 10 } as any });
    const order = await prisma.order.create({
      data: {
        orderNumber: `ORD-${s}`, userId, addressId: address.id, subtotal: 100000, deliveryFee: 10000, totalPrice: 100000,
        paymentMethod: PaymentMethod.BANK_TRANSFER, voucherId: promoId,
        items: { create: [{ productId, productName: 'P', unitPrice: 10000, quantity: 2 }] },
        payment: { create: { method: PaymentMethod.BANK_TRANSFER, amount: 100000 } },
      },
      include: { payment: true },
    });
    await prisma.voucherUsage.create({ data: { voucherId: promoId, userId, orderId: order.id } });
    if (opts.newUser) await prisma.newUserVoucherRedemption.create({ data: { userId, promoId, orderId: order.id } });
    return { userId, orderId: order.id, paymentId: order.payment!.id, promoId, productId };
  }

  async function snapshot(sd: Seed) {
    const [order, payment, usage, promo, redemption, product] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: sd.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: sd.paymentId } }),
      prisma.voucherUsage.findUnique({ where: { orderId: sd.orderId } }),
      prisma.promo.findUniqueOrThrow({ where: { id: sd.promoId } }),
      prisma.newUserVoucherRedemption.findUnique({ where: { orderId: sd.orderId } }),
      prisma.product.findUniqueOrThrow({ where: { id: sd.productId } }),
    ]);
    return {
      orderStatus: order.status,
      paymentStatus: payment.status,
      usageReleased: usage?.releasedAt != null,
      usageRowExists: usage !== null,
      counter: promo.currentUsageCount,
      redemption: redemption !== null,
      stock: product.stock,
    };
  }

  const settlement = (opts: { holdSettle?: boolean; holdCancel?: boolean } = {}) => {
    const cancellation = opts.holdCancel ? new HoldingCancellation() : new OrderCancellationService();
    return new PaymentSettlementService(prisma as any, undefined, opts.holdSettle ? (holdingInventory as any) : undefined, cancellation);
  };
  const SYSTEM = { kind: 'SYSTEM' as const, source: 'pg-test' };
  const ADMIN = { kind: 'ADMIN' as const, adminId: 'admin-1' };

  /** The admin cancellation path (AdminService.updateOrderStatus -> cancelAndRestock), optionally holding. */
  const adminCancel = (orderId: string, hold = false) =>
    prisma.$transaction(
      async (tx) => (hold ? new HoldingCancellation() : new OrderCancellationService()).cancelAndRestock(tx, orderId, 'admin cancel'),
      { timeout: 15_000 },
    );

  const settled = async <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));

  // ------------------------------------------------------------- voucher release
  it('regular + New User release on real unpaid expiry / failure / admin cancel, exactly once', async () => {
    const a = await seed();
    await settlement().expire(a.paymentId, SYSTEM, 'expired');
    expect(await snapshot(a)).toMatchObject({ orderStatus: 'CANCELLED', usageReleased: true, usageRowExists: true, counter: 4, stock: 12 });

    const b = await seed({ newUser: true });
    await settlement().fail(b.paymentId, SYSTEM, 'failed');
    expect(await snapshot(b)).toMatchObject({ usageReleased: true, counter: 4, redemption: false });

    const c = await seed({ newUser: true });
    await adminCancel(c.orderId);
    await adminCancel(c.orderId); // repeated
    await settled(settlement().expire(c.paymentId, SYSTEM, 'late expiry')); // duplicate path
    expect(await snapshot(c)).toMatchObject({ usageReleased: true, counter: 4, redemption: false, stock: 12 });
  });

  // -------------------------------------------------- 13. settlement wins the race
  it('13. settlement wins vs expiry/failure: no cancellation, no inventory or voucher release', async () => {
    for (const loser of ['expire', 'fail'] as const) {
      const sd = await seed({ newUser: true });
      const settle = settled(settlement({ holdSettle: true }).settle(sd.paymentId, ADMIN));
      await wait(START_DELAY_MS);
      const other = settled(loser === 'expire' ? settlement().expire(sd.paymentId, SYSTEM, 'x') : settlement().fail(sd.paymentId, SYSTEM, 'x'));
      const [s, o] = await Promise.all([settle, other]);
      expect(s.ok).toBe(true);
      expect(o.ok).toBe(false); // lost the payment CAS after waiting on the row lock
      expect(await snapshot(sd)).toMatchObject({
        paymentStatus: 'PAID', orderStatus: 'PROCESSING', usageReleased: false, counter: 5, redemption: true, stock: 10,
      });
    }
  });

  it('13b. settlement wins vs admin cancel: the admin cancel waits, then sees PAID - voucher kept (paid cancellation)', async () => {
    const sd = await seed({ newUser: true });
    const settle = settled(settlement({ holdSettle: true }).settle(sd.paymentId, ADMIN));
    await wait(START_DELAY_MS);
    const cancel = settled(adminCancel(sd.orderId));
    const [s, c] = await Promise.all([settle, cancel]);
    expect(s.ok && c.ok).toBe(true);
    const after = await snapshot(sd);
    // The admin explicitly cancelled a now-PAID order: payment stays PAID, the voucher
    // and New User redemption stay consumed. Stock follows the EXISTING paid-cancel
    // restock behaviour (unchanged by P1.2.3).
    expect(after).toMatchObject({ paymentStatus: 'PAID', orderStatus: 'CANCELLED', usageReleased: false, counter: 5, redemption: true });
  });

  // ------------------------------------------------- 14. cancellation wins the race
  it('14. admin cancel wins: the concurrent settlement waits, finds CANCELLED and rolls back - never PAID', async () => {
    const sd = await seed({ newUser: true });
    const cancel = settled(adminCancel(sd.orderId, true));
    await wait(START_DELAY_MS);
    const settle = settled(settlement().settle(sd.paymentId, ADMIN));
    const [c, s] = await Promise.all([cancel, settle]);
    expect(c.ok).toBe(true);
    expect(s.ok).toBe(false);
    expect(await snapshot(sd)).toMatchObject({
      orderStatus: 'CANCELLED', paymentStatus: 'PENDING', usageReleased: true, counter: 4, redemption: false, stock: 12,
    });
  });

  it('14b. expiry wins: the concurrent settlement loses its CAS - payment EXPIRED, voucher released once', async () => {
    const sd = await seed({ newUser: true });
    const expire = settled(settlement({ holdCancel: true }).expire(sd.paymentId, SYSTEM, 'expired'));
    await wait(START_DELAY_MS);
    const settle = settled(settlement().settle(sd.paymentId, ADMIN));
    const [e, s] = await Promise.all([expire, settle]);
    expect(e.ok).toBe(true);
    expect(s.ok).toBe(false);
    expect(await snapshot(sd)).toMatchObject({ paymentStatus: 'EXPIRED', orderStatus: 'CANCELLED', usageReleased: true, counter: 4, redemption: false });
  });

  // --------------------------------------------- 15/16. duplicates are exactly-once
  it('15. duplicate concurrent settlement callbacks: one settles, voucher usage untouched', async () => {
    const sd = await seed({ newUser: true });
    const results = await Promise.all([
      settled(settlement({ holdSettle: true }).settle(sd.paymentId, ADMIN)),
      (async () => (await wait(START_DELAY_MS), settled(settlement().settle(sd.paymentId, ADMIN))))(),
    ]);
    expect(results.filter((r) => r.ok && (r.v as any).result === 'SETTLED')).toHaveLength(1);
    expect(await prisma.voucherUsage.count({ where: { orderId: sd.orderId } })).toBe(1);
    expect(await snapshot(sd)).toMatchObject({ paymentStatus: 'PAID', usageReleased: false, counter: 5, redemption: true });
  });

  it('16. concurrent admin cancellations: exactly one release', async () => {
    const sd = await seed({ newUser: true });
    const results = await Promise.all([
      settled(adminCancel(sd.orderId, true)),
      (async () => (await wait(START_DELAY_MS), settled(adminCancel(sd.orderId))))(),
      (async () => (await wait(START_DELAY_MS), settled(adminCancel(sd.orderId))))(),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && (r.v as any).cancelled)).toHaveLength(1);
    expect(await snapshot(sd)).toMatchObject({ orderStatus: 'CANCELLED', usageReleased: true, counter: 4, redemption: false, stock: 12 });
  });

  // --------------------------------------------------------------- 17. deadlocks
  it('17. mixed concurrent settle / expire / fail / admin-cancel on shared promos: no deadlock, invariants hold', async () => {
    const promoA = await seed({ counter: 40 });
    const promoB = await seed({ newUser: true, counter: 40 });
    const seeds: Seed[] = [];
    for (let i = 0; i < 12; i += 1) seeds.push(await seed({ promoId: i % 2 ? promoA.promoId : promoB.promoId, newUser: i % 2 === 0 }));
    const ops = seeds.flatMap((sd, i) => [
      settled(settlement({ holdSettle: i % 3 === 0 }).settle(sd.paymentId, ADMIN)),
      settled(adminCancel(sd.orderId, i % 3 === 1)),
      settled(i % 2 ? settlement().expire(sd.paymentId, SYSTEM, 'x') : settlement().fail(sd.paymentId, SYSTEM, 'x')),
    ]);
    const results = await Promise.all(ops);
    const errors = results.filter((r) => !r.ok).map((r: any) => String(r.e?.message ?? r.e));
    expect(errors.filter((m) => /deadlock|40P01|P2034/i.test(m))).toEqual([]);
    for (const sd of seeds) {
      const s = await snapshot(sd);
      const paid = s.paymentStatus === 'PAID';
      if (paid) expect(s.usageReleased).toBe(false);
      if (!paid && s.orderStatus === 'CANCELLED') expect(s.usageReleased).toBe(true);
      if (s.orderStatus !== 'CANCELLED') expect(s.usageReleased).toBe(false);
    }
    // Counters moved by exactly one per released usage (seed usages + the two promo-owner seeds).
    for (const owner of [promoA, promoB]) {
      const releasedCount = await prisma.voucherUsage.count({ where: { voucherId: owner.promoId, releasedAt: { not: null } } });
      const promo = await prisma.promo.findUniqueOrThrow({ where: { id: owner.promoId } });
      expect(promo.currentUsageCount).toBe(40 - releasedCount);
    }
  });

  // ------------------------------------------ 18-20. New User classification race
  /** Real checkout reservation (OrdersService.persistOrderOnce), optionally holding its tx open after the voucher block. */
  async function checkout(promoId: string, hold: boolean) {
    const s = randomUUID().slice(0, 8);
    const userId = `cu-${s}`;
    await prisma.user.create({ data: { id: userId, email: `c-${s}@example.test`, name: 'C' } });
    const address = await prisma.address.create({
      data: { userId, label: 'home', recipientName: 'R', phone: '6280000000000', fullAddress: 'a', latitude: 0, longitude: 0 },
    });
    const product = await prisma.product.create({ data: { id: `cp-${s}`, name: `CP ${s}`, slug: `cp-${s}`, description: 'd', imageUrl: 'x', categoryId, price: 100000, stock: 5 } as any });
    const voucherSnapshot = await prisma.promo.findUniqueOrThrow({ where: { id: promoId } }); // the pre-tx gate's view
    const idempotency = { finalize: async (tx: Prisma.TransactionClient) => { if (hold) await sleepIn(tx); } };
    const orders = new OrdersService(prisma as any, {} as any, idempotency as any, { issue: async () => ({ uploadUrl: null }) } as any);
    const order = await (orders as any).persistOrderOnce(`ORD-C-${s}`, {
      userId,
      dto: { address_id: address.id, courier: 'jne', payment_method: PaymentMethod.BANK_TRANSFER, items: [{ product_id: product.id, qty: 1 }] },
      items: [{ productId: product.id, quantity: 1, toppingIds: [] }],
      products: [product],
      toppings: [],
      summary: {
        subtotal: 100000, shipping_cost: 10000, discount: 10000, productDiscountAmount: 10000, shippingDiscountAmount: 0,
        payment_service_fee: 0, payment_service_fee_breakdown: null, grand_total: 100000,
        shipping: { provider: 'jne', service: 'REG', serviceName: 'JNE REG', shippingCost: 10000 },
        voucher: voucherSnapshot,
      },
      idempotencyRecordId: 'idem-test',
      fenceToken: 1,
    });
    return { userId, orderId: order.id as string };
  }

  /** Real AdminService.updatePromo; `hold` keeps its tx open after the real lock + checks, before the write. */
  function admin(hold: boolean) {
    const client = hold
      ? new Proxy(prisma, {
          get(target, prop) {
            if (prop !== '$transaction') return (target as any)[prop];
            return (fn: any, o: any) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, p) {
                        if (p !== 'promo') return (t as any)[p];
                        return { ...t.promo, update: async (args: any) => (await sleepIn(t), t.promo.update(args)) };
                      },
                    }),
                  ),
                o,
              );
          },
        })
      : prisma;
    return new AdminService(client as never, new OrderCancellationService() as never);
  }

  async function regularPromo() {
    const s = randomUUID().slice(0, 8);
    return prisma.promo.create({
      data: { id: `rp-${s}`, code: `RP-${s}`, title: 't', description: 'd', voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10 },
    });
  }

  it('19. checkout reserves first: the admin reclassification waits, then is refused', async () => {
    const promo = await regularPromo();
    const co = settled(checkout(promo.id, true));
    await wait(START_DELAY_MS);
    const ad = settled(admin(false).updatePromo(promo.id, { isNewUserOnly: true } as any));
    const [c, a] = await Promise.all([co, ad]);
    expect(c.ok).toBe(true);
    expect(a.ok).toBe(false);
    expect(String((a as any).e?.message)).toMatch(/New User setting cannot be changed/);
    const after = await prisma.promo.findUniqueOrThrow({ where: { id: promo.id } });
    expect(after.isNewUserOnly).toBe(false);
    expect(await prisma.newUserVoucherRedemption.count({ where: { promoId: promo.id } })).toBe(0);
  });

  it('20. admin reclassifies first: the checkout (regular snapshot) waits, then reserves a New User redemption', async () => {
    const promo = await regularPromo();
    const ad = settled(admin(true).updatePromo(promo.id, { isNewUserOnly: true } as any));
    await wait(START_DELAY_MS);
    const co = settled(checkout(promo.id, false));
    const [a, c] = await Promise.all([ad, co]);
    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
    const { userId, orderId } = (c as any).v;
    expect(await prisma.newUserVoucherRedemption.findUnique({ where: { userId } })).toMatchObject({ promoId: promo.id, orderId });
  });

  it('18. unforced concurrent admin flip vs checkout: never a New User promo usage without a redemption', async () => {
    for (let i = 0; i < 8; i += 1) {
      const promo = await regularPromo();
      const [a, c] = await Promise.all([
        settled(admin(false).updatePromo(promo.id, { isNewUserOnly: true } as any)),
        settled(checkout(promo.id, false)),
      ]);
      expect(c.ok).toBe(true);
      const after = await prisma.promo.findUniqueOrThrow({ where: { id: promo.id } });
      const redemptions = await prisma.newUserVoucherRedemption.count({ where: { promoId: promo.id } });
      if (a.ok) {
        // Admin committed first: checkout must have read the new classification.
        expect(after.isNewUserOnly).toBe(true);
        expect(redemptions).toBe(1);
      } else {
        // Checkout committed first: admin refused, promo stays regular, no redemption.
        expect(after.isNewUserOnly).toBe(false);
        expect(redemptions).toBe(0);
      }
    }
  });
});
