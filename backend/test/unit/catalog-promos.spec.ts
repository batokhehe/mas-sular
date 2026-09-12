import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';

/**
 * P1 #12 — the storefront homepage voucher section (GET /catalog/promos).
 *
 * The reported symptom was "a voucher newly created from Admin does not appear
 * on the homepage". Reproduction showed this filter is CORRECT: a newly created
 * valid voucher does appear. The one valid-looking voucher that never appeared
 * was maxUsageCount = 0, which the Admin list rendered as "0 / ∞" (unlimited)
 * while this filter, checkout (orders.service) and redemption all enforce it as
 * "no uses allowed". The fix is in the Admin UI; these tests pin the semantics
 * that were deliberately PRESERVED, so nobody "fixes" 0 into being advertised
 * as a voucher that checkout would then reject.
 */

const NOW = new Date('2026-09-10T08:42:00.000Z');
const MINUTE = 60_000;

function promo(code: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${code}`,
    code,
    title: code,
    description: 'd',
    isActive: true,
    deletedAt: null,
    startDate: null,
    endDate: null,
    maxUsageCount: null,
    currentUsageCount: 0,
    createdAt: NOW,
    ...over,
  };
}

function repoReturning(rows: ReturnType<typeof promo>[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new PrismaCatalogRepository({ promo: { findMany } } as any);
  return { repo, findMany };
}

async function visibleCodes(rows: ReturnType<typeof promo>[]) {
  const { repo } = repoReturning(rows);
  return (await repo.listPromos()).map((p) => p.code);
}

describe('GET /catalog/promos — homepage voucher visibility', () => {
  beforeAll(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('a newly created valid voucher appears (the Admin -> Homepage flow)', async () => {
    // Exactly what the Admin form persists for a voucher with no window and a
    // blank max-usage field: no dates, maxUsageCount null, nothing used yet.
    expect(await visibleCodes([promo('NEW_VOUCHER')])).toEqual(['NEW_VOUCHER']);
  });

  it('a voucher whose window has just opened appears', async () => {
    const opened = promo('JUST_OPENED', {
      startDate: new Date(NOW.getTime() - MINUTE),
      endDate: new Date(NOW.getTime() + 7 * 24 * 60 * MINUTE),
    });
    expect(await visibleCodes([opened])).toEqual(['JUST_OPENED']);
  });

  it('a not-yet-active voucher is hidden', async () => {
    const future = promo('FUTURE', { startDate: new Date(NOW.getTime() + 60 * MINUTE) });
    expect(await visibleCodes([future])).toEqual([]);
  });

  it('an expired voucher is hidden', async () => {
    const expired = promo('EXPIRED', {
      startDate: new Date(NOW.getTime() - 2 * 24 * 60 * MINUTE),
      endDate: new Date(NOW.getTime() - 24 * 60 * MINUTE),
    });
    expect(await visibleCodes([expired])).toEqual([]);
  });

  it('usage limits: shown below the limit, hidden once reached', async () => {
    expect(await visibleCodes([promo('ROOM_LEFT', { maxUsageCount: 5, currentUsageCount: 4 })])).toEqual([
      'ROOM_LEFT',
    ]);
    expect(await visibleCodes([promo('USED_UP', { maxUsageCount: 5, currentUsageCount: 5 })])).toEqual([]);
  });

  it('maxUsageCount = null is unlimited and stays visible however much it is used', async () => {
    expect(await visibleCodes([promo('UNLIMITED', { maxUsageCount: null, currentUsageCount: 9999 })])).toEqual([
      'UNLIMITED',
    ]);
  });

  it('PRESERVED MEANING: maxUsageCount = 0 is "no uses allowed", not unlimited', async () => {
    // Consistent with checkout ("Voucher usage limit has been reached") and the
    // guarded redemption increment (currentUsageCount < 0 never matches). Showing
    // it would advertise a voucher no customer can use.
    expect(await visibleCodes([promo('ZERO_LIMIT', { maxUsageCount: 0 })])).toEqual([]);
  });

  it('queries only active, non-deleted promos, newest first', async () => {
    const { repo, findMany } = repoReturning([]);
    await repo.listPromos();
    expect(findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  });
});
