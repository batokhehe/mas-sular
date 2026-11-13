import { AdminService } from '../../src/modules/admin/admin.service';

/**
 * P1.2.5 - dashboard voucher redemption metrics count only ACTIVE / CONSUMED usage.
 *
 * A VoucherUsage row released by an unpaid cancelled / expired / failed order
 * (releasedAt set) is kept as history but is not a redemption. The fake below
 * applies the `where` it receives, so exclusion is proven by behaviour, not only
 * by the query arguments.
 */

type Row = { voucherId: string; releasedAt: Date | null };

const RELEASED = new Date('2026-11-01T00:00:00Z');
const ROWS: Row[] = [
  // v1: 3 usages, 1 released -> 2 redemptions
  { voucherId: 'v1', releasedAt: null },
  { voucherId: 'v1', releasedAt: null },
  { voucherId: 'v1', releasedAt: RELEASED },
  // v2: 3 usages, ALL released -> 0 redemptions (must not appear in the top list)
  { voucherId: 'v2', releasedAt: RELEASED },
  { voucherId: 'v2', releasedAt: RELEASED },
  { voucherId: 'v2', releasedAt: RELEASED },
  // v3: 1 usage, unreleased -> 1 redemption
  { voucherId: 'v3', releasedAt: null },
];

const matches = (row: Row, where?: { releasedAt?: null }) =>
  !where || !('releasedAt' in where) || row.releasedAt === where.releasedAt;

function dashboardPrisma(rows: Row[]) {
  const voucherUsage = {
    count: jest.fn(async (args?: { where?: { releasedAt?: null } }) => rows.filter((r) => matches(r, args?.where)).length),
    groupBy: jest.fn(async (args: { where?: { releasedAt?: null }; take?: number }) => {
      const counts = new Map<string, number>();
      for (const r of rows.filter((x) => matches(x, args.where))) counts.set(r.voucherId, (counts.get(r.voucherId) ?? 0) + 1);
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, args.take ?? Infinity)
        .map(([voucherId, n]) => ({ voucherId, _count: { voucherId: n } }));
    }),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  return {
    order: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { totalPrice: 0 } }),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    payment: { count: jest.fn().mockResolvedValue(0) },
    product: { count: jest.fn().mockResolvedValue(0) },
    user: { count: jest.fn().mockResolvedValue(0) },
    promo: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ code: where.id.toUpperCase(), title: `Promo ${where.id}` })),
    },
    voucherUsage,
  };
}

describe('AdminService.getDashboard - voucher redemption metrics (P1.2.5)', () => {
  it('totalRedemptions excludes released usage and still counts unreleased usage', async () => {
    const prisma = dashboardPrisma(ROWS);
    const dashboard = await new AdminService(prisma as any, {} as any).getDashboard();
    expect(dashboard.totalRedemptions).toBe(3); // v1: 2, v3: 1 (all 4 released rows excluded)
    expect(prisma.voucherUsage.count).toHaveBeenCalledWith({ where: { releasedAt: null } });
  });

  it('topUsedVouchers ranks by unreleased usage; a fully released voucher does not appear', async () => {
    const prisma = dashboardPrisma(ROWS);
    const dashboard = await new AdminService(prisma as any, {} as any).getDashboard();
    expect(dashboard.topUsedVouchers).toEqual([
      { voucherId: 'v1', code: 'V1', title: 'Promo v1', redemptions: 2 },
      { voucherId: 'v3', code: 'V3', title: 'Promo v3', redemptions: 1 },
    ]);
    expect(prisma.voucherUsage.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['voucherId'], where: { releasedAt: null }, take: 5 }),
    );
  });

  it('with no released rows the metrics are unchanged (every usage counts)', async () => {
    const unreleased = ROWS.map((r) => ({ ...r, releasedAt: null }));
    const dashboard = await new AdminService(dashboardPrisma(unreleased) as any, {} as any).getDashboard();
    expect(dashboard.totalRedemptions).toBe(7);
    expect(dashboard.topUsedVouchers.map((v: any) => [v.voucherId, v.redemptions])).toEqual([
      ['v1', 3],
      ['v2', 3],
      ['v3', 1],
    ]);
  });

  it('keeps the response shape and never modifies VoucherUsage rows', async () => {
    const prisma = dashboardPrisma(ROWS);
    const dashboard = await new AdminService(prisma as any, {} as any).getDashboard();
    expect(typeof dashboard.totalRedemptions).toBe('number');
    for (const entry of dashboard.topUsedVouchers) {
      expect(Object.keys(entry).sort()).toEqual(['code', 'redemptions', 'title', 'voucherId']);
    }
    expect(prisma.voucherUsage.updateMany).not.toHaveBeenCalled();
    expect(prisma.voucherUsage.deleteMany).not.toHaveBeenCalled();
  });
});

describe('classification freeze still counts released usage (history, not a metric)', () => {
  it('a promo whose only usage was released stays frozen for isNewUserOnly changes', async () => {
    const prisma: any = {
      promo: {
        findUnique: jest.fn(async () => ({
          id: 'v2', code: 'V2', title: 't', description: 'd', voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10,
          discountAmount: null, maxDiscountAmount: null, freeShippingMaxAmount: null,
          productDiscountType: null, productDiscountPercentage: null, productDiscountAmount: null, productMaxDiscountAmount: null,
          shippingDiscountType: null, shippingDiscountPercentage: null, shippingDiscountAmount: null, shippingMaxDiscountAmount: null,
          eligibleCouriers: null, minimumOrderAmount: 0, maxUsageCount: null, currentUsageCount: 0,
          isNewUserOnly: false, isActive: true, deletedAt: null,
        })),
        update: jest.fn(),
      },
      // Only v2's rows, all released: the freeze must still see them.
      voucherUsage: {
        count: jest.fn(async (args: { where: Record<string, unknown> }) =>
          ROWS.filter((r) => r.voucherId === args.where.voucherId && matches(r, args.where as any)).length,
        ),
      },
      $queryRaw: jest.fn(async () => [{ isNewUserOnly: false, currentUsageCount: 0 }]),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    await expect(new AdminService(prisma, {} as any).updatePromo('v2', { isNewUserOnly: true } as any)).rejects.toThrow(
      /New User setting cannot be changed/,
    );
    expect(prisma.voucherUsage.count).toHaveBeenCalledWith({ where: { voucherId: 'v2' } });
    expect(prisma.promo.update).not.toHaveBeenCalled();
  });
});
