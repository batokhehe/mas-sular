import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { Prisma, VoucherType } from '@prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';
import { AdminService } from '../../src/modules/admin/admin.service';

/**
 * P1.2.2 - voucher reuse + one New User redemption per account.
 *
 *  - Regular vouchers: reusable by the same user; only the global quota limits them.
 *  - New User vouchers: ONE redemption per account across ALL New User promos,
 *    reserved inside the order transaction (unique NewUserVoucherRedemption.userId).
 *  - Races lost inside the transaction are the same friendly 400 as the gate.
 *  - Admin: New User classification frozen once used; maxUsageCount >= usage.
 *
 * The database half (unique indexes, CHECK constraints, backfill, concurrent
 * increments) was validated against a real PostgreSQL 16; this suite pins the
 * application half and the schema/migration text both rely on.
 */

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`mock ${code}`, { code, clientVersion: 'test', meta });

describe('checkout reservation (persistOrderOnce)', () => {
  let service: OrdersService;
  let tx: any;

  // `lockedNewUser` = the Promo.isNewUserOnly value the in-transaction quota update
  // returns (the row as it is under the lock), independent of the pre-tx snapshot.
  let lockedNewUser = false;
  const makeTx = () => ({
    product: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
    order: {
      create: jest.fn().mockResolvedValue({ id: 'o1', orderNumber: 'ORD-1', payment: { id: 'pay1' } }),
      count: jest.fn().mockResolvedValue(0),
    },
    voucherUsage: { create: jest.fn().mockResolvedValue({}) },
    newUserVoucherRedemption: { create: jest.fn().mockResolvedValue({}) },
    promo: { update: jest.fn().mockImplementation(async () => ({ id: 'v1', isNewUserOnly: lockedNewUser })) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  });

  beforeEach(() => {
    lockedNewUser = false;
    const prisma = {
      $transaction: jest.fn(async (fn: any) => {
        tx = makeTx();
        return fn(tx);
      }),
    };
    service = new OrdersService(prisma as any, {} as any, {} as any, { issue: jest.fn().mockResolvedValue({ uploadUrl: null }) } as any);
  });

  const summary = (voucher: Record<string, unknown>) => ({
    subtotal: 100000,
    shipping_cost: 10000,
    discount: 10000,
    productDiscountAmount: 10000,
    shippingDiscountAmount: 0,
    payment_service_fee: 0,
    payment_service_fee_breakdown: null,
    grand_total: 100000,
    shipping: { provider: 'jne', service: 'REG', serviceName: 'JNE REG', shippingCost: 10000 },
    voucher: { id: 'v1', code: 'PROMO', voucherType: VoucherType.PERCENTAGE_DISCOUNT, maxUsageCount: null, isNewUserOnly: false, ...voucher },
  });

  const persist = (voucher: Record<string, unknown>, prepare?: (t: any) => void) => {
    const run = (service as any).persistOrderOnce('ORD-1', {
      userId: 'user1',
      dto: { address_id: 'addr1', courier: 'jne', items: [{ product_id: 'p1', qty: 1 }] },
      items: [{ productId: 'p1', quantity: 1, toppingIds: [] }],
      products: [{ id: 'p1', name: 'Product', price: 100000, stock: 10, weightGram: 1000 }],
      toppings: [],
      summary: summary(voucher),
      idempotencyRecordId: null,
      fenceToken: null,
    });
    return run;
  };

  it('a regular voucher records usage and reserves NO New User redemption', async () => {
    await persist({});
    expect(tx.voucherUsage.create).toHaveBeenCalledWith({ data: { voucherId: 'v1', userId: 'user1', orderId: 'o1' } });
    expect(tx.newUserVoucherRedemption.create).not.toHaveBeenCalled();
  });

  it('a New User voucher reserves the account redemption in the SAME transaction', async () => {
    lockedNewUser = true;
    await persist({ isNewUserOnly: true });
    expect(tx.newUserVoucherRedemption.create).toHaveBeenCalledWith({
      data: { userId: 'user1', promoId: 'v1', orderId: 'o1' },
    });
  });

  it('a lost New User race (unique userId) is a friendly 400, not a 500', async () => {
    lockedNewUser = true;
    const realMakeTx = makeTx;
    const prismaService = (service as any).prisma;
    prismaService.$transaction = jest.fn(async (fn: any) => {
      tx = realMakeTx();
      tx.newUserVoucherRedemption.create.mockRejectedValue(known('P2002', { target: ['userId'] }));
      return fn(tx);
    });
    await expect(persist({ isNewUserOnly: true })).rejects.toThrow(
      new BadRequestException('A new customer voucher can only be used once per account'),
    );
  });

  it('classification comes from the LOCKED row: reclassified to New User before checkout -> redemption reserved', async () => {
    lockedNewUser = true; // admin flipped it after the up-front gate ran on a regular snapshot
    await persist({ isNewUserOnly: false });
    expect(tx.order.count).toHaveBeenCalledWith({
      where: {
        userId: 'user1',
        id: { not: 'o1' },
        payment: { is: { OR: [{ status: { in: ['PAID', 'REFUNDED'] } }, { verifiedAt: { not: null } }] } },
      },
    });
    expect(tx.newUserVoucherRedemption.create).toHaveBeenCalledWith({ data: { userId: 'user1', promoId: 'v1', orderId: 'o1' } });
  });

  it('classification comes from the LOCKED row: reclassified to regular before checkout -> no redemption', async () => {
    lockedNewUser = false;
    await persist({ isNewUserOnly: true });
    expect(tx.newUserVoucherRedemption.create).not.toHaveBeenCalled();
  });

  it('a paid order committed after the up-front gate disqualifies inside the transaction', async () => {
    lockedNewUser = true;
    const prismaService = (service as any).prisma;
    prismaService.$transaction = jest.fn(async (fn: any) => {
      tx = makeTx();
      tx.order.count.mockResolvedValue(1);
      return fn(tx);
    });
    await expect(persist({ isNewUserOnly: true })).rejects.toThrow(
      new BadRequestException('Voucher is only available for new customers'),
    );
    expect(tx.newUserVoucherRedemption.create).not.toHaveBeenCalled();
  });

  it('the quota increment is conditional on currentUsageCount < maxUsageCount (atomic guard pinned)', async () => {
    await persist({ maxUsageCount: 5 });
    expect(tx.promo.update).toHaveBeenCalledWith({
      where: { id: 'v1', currentUsageCount: { lt: 5 } },
      data: { currentUsageCount: { increment: 1 } },
    });
  });

  it.each([
    ['P2025 (last unit taken concurrently)', known('P2025')],
    [
      'CHECK Promo_currentUsageCount_within_max (admin lowered the limit concurrently)',
      new Prisma.PrismaClientUnknownRequestError(
        'new row for relation "Promo" violates check constraint "Promo_currentUsageCount_within_max"',
        { clientVersion: 'test' },
      ),
    ],
  ])('a lost quota race via %s is the friendly limit message', async (_label, err) => {
    const prismaService = (service as any).prisma;
    prismaService.$transaction = jest.fn(async (fn: any) => {
      tx = makeTx();
      tx.promo.update.mockRejectedValue(err);
      return fn(tx);
    });
    await expect(persist({ maxUsageCount: 5 })).rejects.toThrow(new BadRequestException('Voucher usage limit has been reached'));
    // Nothing after the failed reservation runs; the transaction rolls back as a whole.
    expect(tx.voucherUsage.create).not.toHaveBeenCalled();
  });

  it('an unrelated database error is not disguised as a voucher message', async () => {
    const prismaService = (service as any).prisma;
    prismaService.$transaction = jest.fn(async (fn: any) => {
      tx = makeTx();
      tx.promo.update.mockRejectedValue(new Error('connection reset'));
      return fn(tx);
    });
    await expect(persist({ maxUsageCount: 5 })).rejects.toThrow('connection reset');
  });
});

describe('admin promo usage rules (updatePromo)', () => {
  let prisma: any;
  let service: AdminService;
  const existing = (over: Record<string, unknown> = {}) => ({
    id: 'promo-1',
    code: 'P',
    title: 't',
    description: 'd',
    voucherType: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 10,
    discountAmount: null,
    maxDiscountAmount: null,
    freeShippingMaxAmount: null,
    productDiscountType: null,
    productDiscountPercentage: null,
    productDiscountAmount: null,
    productMaxDiscountAmount: null,
    shippingDiscountType: null,
    shippingDiscountPercentage: null,
    shippingDiscountAmount: null,
    shippingMaxDiscountAmount: null,
    eligibleCouriers: null,
    minimumOrderAmount: 0,
    maxUsageCount: 10,
    currentUsageCount: 4,
    isNewUserOnly: false,
    isActive: true,
    deletedAt: null,
    ...over,
  });

  // The row the FOR UPDATE returns; tests vary it to model a concurrent change.
  let lockedRow: { isNewUserOnly: boolean; currentUsageCount: number };

  beforeEach(() => {
    lockedRow = { isNewUserOnly: false, currentUsageCount: 4 };
    prisma = {
      promo: {
        findUnique: jest.fn(async () => existing()),
        update: jest.fn(async ({ data }: any) => ({ id: 'promo-1', ...data })),
      },
      voucherUsage: { count: jest.fn().mockResolvedValue(0) },
      $queryRaw: jest.fn(async () => [lockedRow]),
    };
    // The interactive transaction runs on the same client double.
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    service = new AdminService(prisma as never, {} as never);
  });

  it('refuses to flip isNewUserOnly once the promo has usage, with a friendly message', async () => {
    prisma.voucherUsage.count.mockResolvedValue(3);
    await expect(service.updatePromo('promo-1', { isNewUserOnly: true } as any)).rejects.toThrow(
      /New User setting cannot be changed after this voucher has been used/,
    );
    expect(prisma.voucherUsage.count).toHaveBeenCalledWith({ where: { voucherId: 'promo-1' } });
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });

  it('allows flipping isNewUserOnly while the promo has no usage', async () => {
    await service.updatePromo('promo-1', { isNewUserOnly: true } as any);
    expect(prisma.promo.update).toHaveBeenCalledTimes(1);
  });

  it('sending the SAME isNewUserOnly value is not a change and needs no usage lookup', async () => {
    await service.updatePromo('promo-1', { isNewUserOnly: false, title: 'x' } as any);
    expect(prisma.voucherUsage.count).not.toHaveBeenCalled();
    expect(prisma.promo.update).toHaveBeenCalledTimes(1);
  });

  it('classification edits lock the Promo row FOR UPDATE inside a transaction', async () => {
    await service.updatePromo('promo-1', { isNewUserOnly: true } as any);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join('?')).toMatch(/FROM "Promo" WHERE id = \? FOR UPDATE/);
  });

  it('judges the rule on the LOCKED row: a concurrent change makes the "same" value a real change', async () => {
    // Snapshot says false (no change requested), but under the lock the row is true:
    // writing false is a reclassification and must be checked against usage.
    lockedRow = { isNewUserOnly: true, currentUsageCount: 1 };
    prisma.voucherUsage.count.mockResolvedValue(1);
    await expect(service.updatePromo('promo-1', { isNewUserOnly: false } as any)).rejects.toThrow(
      /New User setting cannot be changed/,
    );
  });

  it('judges maxUsageCount on the LOCKED currentUsageCount (usage committed meanwhile)', async () => {
    lockedRow = { isNewUserOnly: false, currentUsageCount: 7 }; // snapshot had 4
    await expect(service.updatePromo('promo-1', { maxUsageCount: 5 } as any)).rejects.toThrow(
      'Maximum usage cannot be lower than the usage already counted for this voucher',
    );
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });

  it('edits that cannot affect usage rules keep the plain single write (no transaction)', async () => {
    await service.updatePromo('promo-1', { title: 'renamed' } as any);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.promo.update).toHaveBeenCalledTimes(1);
  });

  it('refuses maxUsageCount below currentUsageCount', async () => {
    await expect(service.updatePromo('promo-1', { maxUsageCount: 3 } as any)).rejects.toThrow(
      'Maximum usage cannot be lower than the usage already counted for this voucher',
    );
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });

  it.each([4, 50, null])('accepts maxUsageCount %p (equal, higher, or unlimited)', async (max) => {
    await service.updatePromo('promo-1', { maxUsageCount: max } as any);
    expect(prisma.promo.update).toHaveBeenCalledTimes(1);
  });

  it('maps the CHECK backstop (concurrent checkout) to the same friendly message', async () => {
    prisma.promo.update.mockRejectedValue(
      new Prisma.PrismaClientUnknownRequestError(
        'new row for relation "Promo" violates check constraint "Promo_currentUsageCount_within_max"',
        { clientVersion: 'test' },
      ),
    );
    await expect(service.updatePromo('promo-1', { maxUsageCount: 5 } as any)).rejects.toThrow(
      new BadRequestException('Maximum usage cannot be lower than the usage already counted for this voucher'),
    );
  });
});

describe('schema and migration invariants', () => {
  const backend = join(__dirname, '..', '..');
  const schema = readFileSync(join(backend, 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const migration = readFileSync(
    join(backend, 'prisma', 'migrations', '20261113090000_voucher_reuse_new_user_redemption', 'migration.sql'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const model = (name: string) => {
    const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!m) throw new Error(`model ${name} missing`);
    return m[1];
  };

  it('VoucherUsage: (voucherId, userId) is no longer unique; orderId stays unique; releasedAt exists', () => {
    const usage = model('VoucherUsage');
    expect(usage).not.toMatch(/@@unique\(\[voucherId, userId\]\)/);
    expect(usage).toMatch(/@@index\(\[voucherId, userId\]\)/);
    expect(usage).toMatch(/orderId\s+String\s+@unique/);
    expect(usage).toMatch(/releasedAt\s+DateTime\?/);
  });

  it('NewUserVoucherRedemption: userId and orderId unique, promo/order not cascade-deleted', () => {
    const r = model('NewUserVoucherRedemption');
    expect(r).toMatch(/userId\s+String\s+@unique/);
    expect(r).toMatch(/orderId\s+String\s+@unique/);
    expect(r).toMatch(/promo\s+Promo\s+@relation\(fields: \[promoId\], references: \[id\], onDelete: NoAction\)/);
    expect(r).toMatch(/order\s+Order\s+@relation\(fields: \[orderId\], references: \[id\], onDelete: NoAction\)/);
  });

  it('the migration drops the old unique, keeps history, adds both counter CHECKs', () => {
    expect(migration).toContain('DROP INDEX "VoucherUsage_voucherId_userId_key";');
    expect(migration).toContain('CREATE INDEX "VoucherUsage_voucherId_userId_idx"');
    expect(migration).toContain('CHECK ("currentUsageCount" >= 0)');
    expect(migration).toContain('CHECK ("maxUsageCount" IS NULL OR "currentUsageCount" <= "maxUsageCount")');
    // Historical rows are never deleted and counters never corrected.
    expect(migration).not.toMatch(/DELETE\s+FROM\s+"VoucherUsage"/i);
    expect(migration).not.toMatch(/UPDATE\s+"Promo"/i);
  });

  it('the backfill uses only real PaymentStatus values', () => {
    const enumBlock = /enum PaymentStatus \{([^}]*)\}/.exec(schema)![1];
    const values = enumBlock.trim().split(/\s+/);
    const used = [...migration.matchAll(/'(PENDING|WAITING_VERIFICATION|PAID|FAILED|EXPIRED|REFUNDED|[A-Z_]+)'/g)]
      .map((m) => m[1])
      .filter((v) => v !== 'CANCELLED'); // OrderStatus, not PaymentStatus
    for (const v of used) expect(values).toContain(v);
  });
});
