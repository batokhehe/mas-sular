/**
 * deactivate-jne-mappings.ts: the rollback for a JNE mapping that must stop resolving.
 * Offline - the store below applies the tool's WHERE clauses as PostgreSQL would and
 * rolls a failed transaction back, so "nothing written" is checked, not assumed.
 */
import {
  DEACTIVATION_TIMEOUT_MS,
  MappingChangedError,
  decideDeactivations,
  parsePairs,
  runDeactivations,
  type DeactivationStore,
} from '../../prisma/tools/deactivate-jne-mappings';

type Row = {
  id: string;
  districtCode: string;
  jneCode: string;
  kind: string;
  status: string;
  isActive: boolean;
  updatedAt: Date;
  notes: string | null;
};

const T0 = new Date('2026-09-14T09:26:19.484Z');
const AT = () => new Date('2026-10-30T01:02:03.000Z');
const quiet = () => undefined;

function rows(): Row[] {
  return [
    { id: 'm-andir', districtCode: '32.73.05', jneCode: 'BDO10041', kind: 'DESTINATION', status: 'MATCHED', isActive: true, updatedAt: T0, notes: 'reviewed alias' },
    { id: 'm-bojong', districtCode: '32.04.08', jneCode: 'BDO10104', kind: 'DESTINATION', status: 'REVIEW_REQUIRED', isActive: true, updatedAt: T0, notes: null },
    { id: 'm-old', districtCode: '32.73.20', jneCode: 'BDO10038', kind: 'DESTINATION', status: 'MATCHED', isActive: false, updatedAt: T0, notes: null },
  ];
}

/** A store over `data`; a transaction works on a copy and commits only if it resolves. */
function storeOver(data: Row[], hooks: { beforeUpdate?: (rows: Row[]) => void } = {}) {
  const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const txOptions: unknown[] = [];
  const view = (rs: Row[]): DeactivationStore => ({
    jneDistrictMapping: {
      findMany: async ({ where }: { where: { district: { code: { in: string[] } } } }) =>
        rs
          .filter((r) => where.district.code.in.includes(r.districtCode))
          .map((r) => ({ id: r.id, status: r.status, isActive: r.isActive, updatedAt: r.updatedAt, notes: r.notes, district: { code: r.districtCode }, jneLocation: { code: r.jneCode, kind: r.kind } })),
      updateMany: async ({ where, data: patch }: { where: unknown; data: unknown }) => {
        calls.push({ where: where as Record<string, unknown>, data: patch as Record<string, unknown> });
        hooks.beforeUpdate?.(rs);
        const w = where as { id: string; status: string; isActive: boolean; updatedAt: Date };
        const hit = rs.filter((r) => r.id === w.id && r.status === w.status && r.isActive === w.isActive && r.updatedAt.getTime() === w.updatedAt.getTime());
        hit.forEach((r) => Object.assign(r, patch as Partial<Row>, { updatedAt: AT() }));
        return { count: hit.length };
      },
    } as never,
    $transaction: async (fn, options) => {
      txOptions.push(options);
      const copy = rs.map((r) => ({ ...r }));
      const result = await fn(view(copy));
      rs.splice(0, rs.length, ...copy);
      return result;
    },
  });
  return { store: view(data), calls, txOptions };
}

const pairs = (...ps: Array<[string, string]>) => ['district_code,jne_code', ...ps.map(([d, c]) => `${d},${c}`)].join('\n') + '\n';
const OPTS = { reason: 'wrong tariff code confirmed by JNE', operator: 'ops-lead', confirm: false };

describe('decideDeactivations', () => {
  const state = rows().map((r) => ({ ...r }));

  it('an active pair is deactivated whatever its status; an inactive one is a no-op', () => {
    const d = decideDeactivations(parsePairs(pairs(['32.73.05', 'BDO10041'], ['32.04.08', 'bdo10104'], ['32.73.20', 'BDO10038'])), state);
    expect(d.map((x) => [x.row.districtCode, x.outcome])).toEqual([
      ['32.04.08', 'DEACTIVATE'],
      ['32.73.05', 'DEACTIVATE'],
      ['32.73.20', 'NOOP'],
    ]);
  });

  it.each([
    ['an unknown pair', [['32.73.05', 'BDO99999']], /no DESTINATION mapping/],
    ['the right district with another code', [['32.04.08', 'BDO10041']], /no DESTINATION mapping/],
    ['a pair listed twice', [['32.73.05', 'BDO10041'], ['32.73.05', 'BDO10041']], /duplicate row/],
    ['a district listed with two codes', [['32.73.05', 'BDO10041'], ['32.73.05', 'BDO10042']], /more than one code/],
    ['a malformed code', [['32.73.5', 'BDO10041']], /malformed/],
  ])('%s is refused', (_what, ps, reason) => {
    const d = decideDeactivations(parsePairs(pairs(...(ps as Array<[string, string]>))), state);
    expect(d.some((x) => x.outcome === 'REFUSE' && reason.test(x.reason))).toBe(true);
  });

  it('an ORIGIN row with the same code is never a target', () => {
    const d = decideDeactivations(parsePairs(pairs(['32.73.05', 'BDO10041'])), [{ ...state[0], kind: 'ORIGIN' }]);
    expect(d[0]).toMatchObject({ outcome: 'REFUSE', reason: 'no DESTINATION mapping for this pair' });
  });
});

describe('runDeactivations', () => {
  it('a dry run is the default and writes nothing', async () => {
    const data = rows();
    const { store, calls } = storeOver(data);
    const lines: string[] = [];
    const res = await runDeactivations(store, pairs(['32.73.05', 'BDO10041']), OPTS, (l) => lines.push(l), AT);
    expect(res).toMatchObject({ code: 0, deactivated: 0 });
    expect(calls).toEqual([]);
    expect(data).toEqual(rows());
    expect(lines.join('\n')).toContain('--confirm --expect-count 1');
  });

  it.each([
    ['no operator', { operator: ' ' }],
    ['no reason', { reason: '' }],
    ['a reason too short to review', { reason: 'wrong' }],
    ['--confirm without --expect-count', { confirm: true }],
    ['--expect-count 0', { confirm: true, expectCount: 0 }],
    ['a non-integer --expect-count', { confirm: true, expectCount: 1.5 }],
  ])('%s: exit 2 before the database is read', async (_what, over) => {
    const data = rows();
    const { store, calls } = storeOver(data);
    const findMany = jest.spyOn(store.jneDistrictMapping, 'findMany');
    expect((await runDeactivations(store, pairs(['32.73.05', 'BDO10041']), { ...OPTS, ...over }, quiet, AT)).code).toBe(2);
    expect(findMany).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('any refused row blocks the whole write', async () => {
    const data = rows();
    const { store, calls } = storeOver(data);
    const res = await runDeactivations(store, pairs(['32.73.05', 'BDO10041'], ['32.73.05', 'BDO99999']), { ...OPTS, confirm: true, expectCount: 1 }, quiet, AT);
    expect(res.code).toBe(4);
    expect(calls).toEqual([]);
    expect(data).toEqual(rows());
  });

  it('an --expect-count that differs from the reviewed dry run writes nothing', async () => {
    const data = rows();
    const { store, calls } = storeOver(data);
    const res = await runDeactivations(store, pairs(['32.73.05', 'BDO10041'], ['32.04.08', 'BDO10104']), { ...OPTS, confirm: true, expectCount: 1 }, quiet, AT);
    expect(res.code).toBe(5);
    expect(calls).toEqual([]);
    expect(data).toEqual(rows());
  });

  it('confirmed: exactly the listed rows, guarded by their full observed state, in one serializable transaction', async () => {
    const data = rows();
    const { store, calls, txOptions } = storeOver(data);
    const lines: string[] = [];
    const res = await runDeactivations(store, pairs(['32.73.05', 'BDO10041'], ['32.04.08', 'BDO10104'], ['32.73.20', 'BDO10038']), { ...OPTS, confirm: true, expectCount: 2 }, (l) => lines.push(l), AT);
    expect(res).toMatchObject({ code: 0, deactivated: 2 });
    expect(txOptions).toEqual([{ timeout: DEACTIVATION_TIMEOUT_MS, isolationLevel: 'Serializable' }]);
    expect(calls.map((c) => c.where)).toEqual([
      { id: 'm-bojong', status: 'REVIEW_REQUIRED', isActive: true, updatedAt: T0 },
      { id: 'm-andir', status: 'MATCHED', isActive: true, updatedAt: T0 },
    ]);
    const after = Object.fromEntries(data.map((r) => [r.id, r]));
    expect(after['m-andir']).toMatchObject({ isActive: false, status: 'MATCHED', notes: 'reviewed alias\n[2026-10-30T01:02:03.000Z] deactivated by ops-lead: wrong tariff code confirmed by JNE' });
    expect(after['m-bojong']).toMatchObject({ isActive: false, notes: '[2026-10-30T01:02:03.000Z] deactivated by ops-lead: wrong tariff code confirmed by JNE' });
    // The already-inactive row is not touched, and no row is ever deleted or re-pointed.
    expect(after['m-old']).toEqual(rows()[2]);
    expect(data).toHaveLength(3);
    expect(Object.keys(calls[0].data).sort()).toEqual(['isActive', 'notes']);
    expect(lines.join('\n')).toContain('deactivated 2 mapping(s) by ops-lead');
  });

  it.each([
    ['approved in the meantime', (r: Row) => (r.status = 'MATCHED')],
    ['deactivated by someone else', (r: Row) => (r.isActive = false)],
    ['touched in any other way', (r: Row) => (r.updatedAt = new Date('2026-10-30T00:00:00Z'))],
  ])('a row %s since the dry run aborts the run and nothing is written', async (_what, mutate) => {
    const data = rows();
    let once = false;
    const { store } = storeOver(data, {
      beforeUpdate: (rs) => {
        if (once) return;
        once = true;
        mutate(rs.find((r) => r.id === 'm-bojong')!);
      },
    });
    await expect(
      runDeactivations(store, pairs(['32.73.05', 'BDO10041'], ['32.04.08', 'BDO10104']), { ...OPTS, confirm: true, expectCount: 2 }, quiet, AT),
    ).rejects.toThrow(MappingChangedError);
    expect(data).toEqual(rows());
  });

  it('a write count that disagrees with --expect-count inside the transaction rolls everything back', async () => {
    const data = rows();
    const { store } = storeOver(data);
    const original = store.$transaction.bind(store);
    // Simulate an update hitting more rows than the guard allows.
    store.$transaction = (fn, o) =>
      original(async (tx) => {
        const real = tx.jneDistrictMapping.updateMany;
        tx.jneDistrictMapping.updateMany = async (args) => ({ count: (await real(args)).count * 2 });
        return fn(tx);
      }, o);
    await expect(runDeactivations(store, pairs(['32.73.05', 'BDO10041']), { ...OPTS, confirm: true, expectCount: 1 }, quiet, AT)).rejects.toThrow(/changed since the dry run/);
    expect(data).toEqual(rows());
  });

  it('the output names codes, statuses, the reason and the operator - nothing else', async () => {
    const data = rows();
    data[0].notes = 'Jl. Pelanggan Rahasia No. 7, 40288';
    const { store } = storeOver(data);
    const lines: string[] = [];
    await runDeactivations(store, pairs(['32.73.05', 'BDO10041']), OPTS, (l) => lines.push(l), AT);
    const out = lines.join('\n');
    expect(out).not.toContain('Pelanggan');
    expect(out).not.toContain('40288');
    expect(out).toMatch(/record 1 32\.73\.05 -> BDO10041: DEACTIVATE \(MATCHED -> inactive\)/);
  });
});
