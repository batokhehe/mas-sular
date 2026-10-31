/**
 * reactivate-jne-mappings.ts: the reviewed way back for a retired mapping. Offline - the
 * store applies the tool's WHERE clauses as PostgreSQL would and rolls a failed transaction
 * back, so "nothing written" is checked, not assumed. Concurrency against the real partial
 * unique index is in test/integration/jne-reactivate-mappings.int-spec.ts.
 */
import { toCsv } from '../../prisma/tools/csv';
import {
  MappingChangedError,
  REVIEW_COLUMNS,
  parseReview,
  prepareReview,
  reactivationPlanHash,
  decideReactivations,
  runReactivations,
  type ReactivationStore,
} from '../../prisma/tools/reactivate-jne-mappings';

const RETIRED_AT = new Date('2026-10-30T01:00:00.000Z');

type Row = {
  id: string;
  districtId: string;
  districtCode: string;
  jneLocationId: string;
  jneCode: string;
  kind: string;
  locationActive: boolean;
  districtActive: boolean;
  status: string;
  isActive: boolean;
  updatedAt: Date;
  notes: string | null;
};

const row = (over: Partial<Row> = {}): Row => ({
  id: 'm1',
  districtId: 'd1',
  districtCode: '32.04.08',
  jneLocationId: 'loc1',
  jneCode: 'BDO10104',
  kind: 'DESTINATION',
  locationActive: true,
  districtActive: true,
  status: 'MATCHED',
  isActive: false,
  updatedAt: RETIRED_AT,
  notes: '[2026-10-30T01:00:00.000Z] deactivated by ops: code retired in error',
  ...over,
});

function memory(rows: Row[]) {
  const state = { rows: rows.map((r) => ({ ...r })) };
  const calls = { writes: 0, transactions: [] as Array<string | undefined> };
  let failOnWrite = false;
  let beforeTx: (() => void) | undefined;
  const store: ReactivationStore = {
    jneDistrictMapping: {
      findMany: async (args) => {
        const where = (args as { where: { OR: Array<Record<string, { in?: string[]; code?: { in: string[] } }>>; district?: { code: { in: string[] } } } }).where;
        const hit = (r: Row) => {
          const clauses = where.OR ?? [where];
          return clauses.some((c) => c.id?.in?.includes(r.id) || c.districtId?.in?.includes(r.districtId) || (c.district as { code?: { in: string[] } } | undefined)?.code?.in.includes(r.districtCode));
        };
        return state.rows.filter(hit).map((r) => ({
          id: r.id,
          districtId: r.districtId,
          jneLocationId: r.jneLocationId,
          status: r.status,
          isActive: r.isActive,
          updatedAt: r.updatedAt,
          notes: r.notes,
          district: { code: r.districtCode, isActive: r.districtActive, city: { isActive: true } },
          jneLocation: { code: r.jneCode, kind: r.kind, isActive: r.locationActive },
        }));
      },
      updateMany: async ({ where, data }) => {
        calls.writes += 1;
        if (failOnWrite) throw new Error('simulated write failure');
        const hit = state.rows.filter(
          (r) => r.id === where.id && r.status === where.status && r.isActive === where.isActive && r.updatedAt === where.updatedAt && r.districtId === where.districtId && r.jneLocationId === where.jneLocationId && r.locationActive && r.districtActive,
        );
        for (const r of hit) Object.assign(r, data, { updatedAt: new Date(RETIRED_AT.getTime() + 1000) });
        return { count: hit.length };
      },
    },
    $transaction: async (fn, options) => {
      calls.transactions.push(options?.isolationLevel);
      beforeTx?.();
      const copy = state.rows.map((r) => ({ ...r }));
      try {
        return await fn(store);
      } catch (err) {
        state.rows = copy;
        throw err;
      }
    },
  };
  return { store, state, calls, failWrites: () => (failOnWrite = true), onBeforeTx: (fn: () => void) => (beforeTx = fn) };
}

const review = (over: Partial<Record<(typeof REVIEW_COLUMNS)[number], string>> = {}) => ({
  mapping_id: 'm1',
  district_code: '32.04.08',
  jne_code: 'BDO10104',
  expected_status: 'MATCHED',
  expected_is_active: 'false',
  expected_updated_at: RETIRED_AT.toISOString(),
  reviewer: 'Rina Reviewer',
  reason: 'retired in error during the rehearsal',
  review_reference: 'REV-1',
  ...over,
});
const file = (...rows: Array<ReturnType<typeof review>>) => toCsv(REVIEW_COLUMNS, rows);
const NOW = () => new Date('2026-10-31T00:00:00.000Z');
const OPS = { operator: 'Ops One', confirm: false };

/** A dry run, then a confirmed run with the hash and count it printed. */
async function confirmed(m: ReturnType<typeof memory>, text: string, over = {}) {
  const dry = await runReactivations(m.store, text, OPS, () => {}, NOW);
  return runReactivations(m.store, text, { ...OPS, confirm: true, expectCount: 1, expectPlan: dry.planSha256, ...over }, () => {}, NOW);
}

describe('a reviewed reactivation', () => {
  it('restores exactly the listed row, keeping its id, location, status and review', async () => {
    const m = memory([row({ notes: 'first note' })]);
    const r = await confirmed(m, file(review()));
    expect(r).toMatchObject({ code: 0, reactivated: 1 });
    expect(m.state.rows[0]).toMatchObject({ id: 'm1', districtId: 'd1', jneLocationId: 'loc1', status: 'MATCHED', isActive: true });
  });

  it('appends who, why and the state change to notes, keeping what was there', async () => {
    const m = memory([row({ notes: 'first note' })]);
    await confirmed(m, file(review()));
    expect(m.state.rows[0].notes).toBe(
      'first note\n[2026-10-31T00:00:00.000Z] reactivated by Ops One, reviewed by Rina Reviewer (REV-1): retired in error during the rehearsal; was MATCHED/inactive, now MATCHED/active',
    );
  });

  it('works on a retired REVIEW_REQUIRED row, which stays REVIEW_REQUIRED', async () => {
    const m = memory([row({ status: 'REVIEW_REQUIRED' })]);
    const r = await confirmed(m, file(review({ expected_status: 'REVIEW_REQUIRED' })));
    expect(r.code).toBe(0);
    expect(m.state.rows[0]).toMatchObject({ status: 'REVIEW_REQUIRED', isActive: true });
  });

  it('is a dry run unless confirmed', async () => {
    const m = memory([row()]);
    const r = await runReactivations(m.store, file(review()), OPS, () => {}, NOW);
    expect(r).toMatchObject({ code: 0, reactivated: 0 });
    expect(m.calls.writes).toBe(0);
    expect(m.calls.transactions).toEqual([]);
  });

  it('uses one serializable transaction', async () => {
    const m = memory([row()]);
    await confirmed(m, file(review()));
    expect(m.calls.transactions).toEqual(['Serializable']);
  });
});

describe('refused reviews change nothing', () => {
  it.each([
    ['no reviewer', { reviewer: ' ' }, /reviewer is required/],
    ['no reason', { reason: '' }, /reason is required/],
    ['a token reason', { reason: 'ok' }, /reason is required/],
    ['no review reference', { review_reference: '' }, /review_reference is required/],
    ['a wrong mapping id', { mapping_id: 'nope' }, /no mapping nope/],
    ['a wrong district', { district_code: '32.04.09' }, /belongs to district 32.04.08/],
    ['a wrong code', { jne_code: 'BDO99999' }, /points at BDO10104/],
    ['a wrong status', { expected_status: 'REVIEW_REQUIRED' }, /status is MATCHED/],
    ['an expected active state', { expected_is_active: 'true' }, /only a retired mapping/],
    ['a stale row version', { expected_updated_at: '2026-10-29T00:00:00.000Z' }, /row was last changed/],
    ['an unreadable row version', { expected_updated_at: 'yesterday' }, /row was last changed/],
  ])('%s', async (_label, over, message) => {
    const m = memory([row()]);
    const r = await confirmed(m, file(review(over)));
    expect(r.code).toBe(4);
    const d = r.decisions[0];
    expect(d.outcome === 'REFUSE' && d.reason).toMatch(message);
    expect(m.calls.writes).toBe(0);
    expect(m.state.rows[0].isActive).toBe(false);
  });

  it.each([
    ['already active', row({ isActive: true }), /already active/],
    ['on an inactive destination', row({ locationActive: false }), /JNE location BDO10104 is inactive/],
    ['on an ORIGIN row', row({ kind: 'ORIGIN' }), /points at a ORIGIN row/],
    ['in an inactive district', row({ districtActive: false }), /district \(or its city\) is inactive/],
    ['with an AMBIGUOUS status', row({ status: 'AMBIGUOUS' }), /AMBIGUOUS mapping cannot be reactivated/],
  ])('a mapping %s', async (_label, state, message) => {
    const m = memory([state]);
    const r = await confirmed(m, file(review({ expected_status: state.status })));
    expect(r.code).toBe(4);
    const d = r.decisions[0];
    expect(d.outcome === 'REFUSE' && d.reason).toMatch(message);
    expect(m.calls.writes).toBe(0);
  });

  it.each([
    ['MATCHED', /active MATCHED mapping for BDO20000/],
    ['REVIEW_REQUIRED', /active REVIEW_REQUIRED mapping for BDO20000/],
  ])('an active %s mapping for the district', async (status, message) => {
    const m = memory([row(), row({ id: 'm2', jneLocationId: 'loc2', jneCode: 'BDO20000', status, isActive: true })]);
    const r = await confirmed(m, file(review()));
    expect(r.code).toBe(4);
    const d = r.decisions[0];
    expect(d.outcome === 'REFUSE' && d.reason).toMatch(message);
    expect(m.state.rows[0].isActive).toBe(false);
  });

  it('an inactive sibling does not block', async () => {
    const m = memory([row(), row({ id: 'm2', jneLocationId: 'loc2', jneCode: 'BDO20000', isActive: false })]);
    expect((await confirmed(m, file(review()))).code).toBe(0);
  });

  it('one bad row refuses the whole file', async () => {
    const m = memory([row(), row({ id: 'm2', districtId: 'd2', districtCode: '32.04.09', jneLocationId: 'loc2', jneCode: 'BDO20000' })]);
    const text = file(review(), review({ mapping_id: 'm2', district_code: '32.04.09', jne_code: 'BDO20000', reviewer: '' }));
    const dry = await runReactivations(m.store, text, OPS, () => {}, NOW);
    const r = await runReactivations(m.store, text, { ...OPS, confirm: true, expectCount: 1, expectPlan: dry.planSha256 }, () => {}, NOW);
    expect(r.code).toBe(4);
    expect(m.calls.writes).toBe(0);
  });

  it('two rows for one district are refused: each alone would pass', async () => {
    const m = memory([row(), row({ id: 'm2', jneLocationId: 'loc2', jneCode: 'BDO20000' })]);
    const r = await confirmed(m, file(review(), review({ mapping_id: 'm2', jne_code: 'BDO20000' })), { expectCount: 2 });
    expect(r.code).toBe(4);
    expect(r.decisions.every((d) => d.outcome === 'REFUSE')).toBe(true);
  });

  it('the same mapping listed twice is refused', () => {
    const rows = parseReview(file(review(), review()));
    expect(decideReactivations(rows, []).every((d) => d.outcome === 'REFUSE')).toBe(true);
  });
});

describe('explicit confirmation', () => {
  it('needs an operator', async () => {
    const m = memory([row()]);
    expect((await runReactivations(m.store, file(review()), { operator: ' ', confirm: false }, () => {}, NOW)).code).toBe(2);
  });

  it('refuses an empty file', async () => {
    const m = memory([row()]);
    expect((await runReactivations(m.store, toCsv(REVIEW_COLUMNS, []), OPS, () => {}, NOW)).code).toBe(2);
  });

  it.each([
    ['no count', { expectCount: undefined }],
    ['a wrong count', { expectCount: 2 }],
  ])('refuses %s', async (_label, over) => {
    const m = memory([row()]);
    expect((await confirmed(m, file(review()), over)).code).toBe(5);
    expect(m.calls.writes).toBe(0);
  });

  it('refuses a plan hash from another review', async () => {
    const m = memory([row()]);
    const lines: string[] = [];
    const r = await runReactivations(m.store, file(review()), { ...OPS, confirm: true, expectCount: 1, expectPlan: 'stale' }, (l) => lines.push(l), NOW);
    expect(r.code).toBe(5);
    expect(lines.join('\n')).toMatch(/PLAN_MISMATCH/);
  });

  it.each([
    ['reviewer', { reviewer: 'Someone Else' }],
    ['reason', { reason: 'another reason entirely' }],
    ['reference', { review_reference: 'REV-2' }],
    ['row version', { expected_updated_at: '2026-10-29T00:00:00.000Z' }],
  ])('binds the %s into the plan hash', (_label, over) => {
    const hash = (r: ReturnType<typeof review>) => reactivationPlanHash(decideReactivations(parseReview(file(r)), []), 'ops');
    expect(hash(review(over))).not.toBe(hash(review()));
  });

  it('binds the operator into the plan hash', () => {
    const d = decideReactivations(parseReview(file(review())), []);
    expect(reactivationPlanHash(d, 'a')).not.toBe(reactivationPlanHash(d, 'b'));
  });
});

describe('inside the transaction', () => {
  it('a mapping approved after the dry run stops the run', async () => {
    const m = memory([row()]);
    m.onBeforeTx(() => m.state.rows.push(row({ id: 'late', jneLocationId: 'loc2', jneCode: 'BDO20000', isActive: true })));
    await expect(confirmed(m, file(review()))).rejects.toThrow(MappingChangedError);
    expect(m.state.rows.find((r) => r.id === 'm1')!.isActive).toBe(false);
    expect(m.calls.writes).toBe(0);
  });

  it('a row changed after the dry run stops the run', async () => {
    const m = memory([row()]);
    m.onBeforeTx(() => (m.state.rows[0].updatedAt = new Date('2026-10-31T00:00:00.000Z')));
    await expect(confirmed(m, file(review()))).rejects.toThrow(/changed since the dry run/);
  });

  it('a failed write leaves every row as it was', async () => {
    const m = memory([row(), row({ id: 'm2', districtId: 'd2', districtCode: '32.04.09', jneLocationId: 'loc2', jneCode: 'BDO20000' })]);
    const before = JSON.stringify(m.state.rows);
    const text = file(review(), review({ mapping_id: 'm2', district_code: '32.04.09', jne_code: 'BDO20000' }));
    const dry = await runReactivations(m.store, text, OPS, () => {}, NOW);
    m.failWrites();
    await expect(runReactivations(m.store, text, { ...OPS, confirm: true, expectCount: 2, expectPlan: dry.planSha256 }, () => {}, NOW)).rejects.toThrow('simulated write failure');
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });
});

describe('repeating', () => {
  it('a second run is refused, not skipped, and changes nothing', async () => {
    const m = memory([row()]);
    await confirmed(m, file(review()));
    const after = JSON.stringify(m.state.rows);
    const writes = m.calls.writes;
    const r = await confirmed(m, file(review()));
    expect(r.code).toBe(4);
    expect(m.calls.writes).toBe(writes);
    expect(JSON.stringify(m.state.rows)).toBe(after);
  });
});

describe('preparing a review', () => {
  const pairs = 'district_code,jne_code\n32.04.08,BDO10104\n';

  it('fills the reviewed state and leaves the review itself blank', async () => {
    const m = memory([row()]);
    const rows = parseReview(await prepareReview(m.store, pairs));
    expect(rows).toEqual([
      expect.objectContaining({ mappingId: 'm1', districtCode: '32.04.08', jneCode: 'BDO10104', expectedStatus: 'MATCHED', expectedIsActive: 'false', expectedUpdatedAt: RETIRED_AT.toISOString(), reviewer: '', reason: '', reviewReference: '' }),
    ]);
  });

  it('writes nothing', async () => {
    const m = memory([row()]);
    await prepareReview(m.store, pairs);
    expect(m.calls.writes).toBe(0);
  });

  it('a prepared file is refused until a person completes it', async () => {
    const m = memory([row()]);
    const r = await confirmed(m, await prepareReview(m.store, pairs));
    expect(r.code).toBe(4);
  });

  it('refuses an active or unknown pair', async () => {
    await expect(prepareReview(memory([row({ isActive: true })]).store, pairs)).rejects.toThrow(/nothing to reactivate/);
    await expect(prepareReview(memory([]).store, pairs)).rejects.toThrow(/no DESTINATION mapping/);
  });
});
