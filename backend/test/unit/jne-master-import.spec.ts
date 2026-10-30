import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  MasterChangedError,
  RETIRED_FLAGS,
  loadSnapshot,
  main,
  parseArgs,
  parseCodeList,
  parseProvenance,
  parseReviewedRenames,
  runDeactivateMissing,
  runImport,
  runLiveDryRun,
  usageProblem,
  writeReports,
  type MasterState,
  type MasterStore,
} from '../../prisma/tools/import-jne-master';
import { locationFingerprint, planMasterImport, type PlanInput, type SnapshotExpectations, type TargetEnvironment } from '../../prisma/tools/jne-master-plan';
import type { JneDataSource, JneLocationKind, JneMasterRaw } from '../../prisma/tools/jne-master';
import { JneOriginBootValidator } from '../../src/modules/shipment/jne-origin-boot.validator';

/**
 * The JNE master import against an in-memory store: every decision the tool makes
 * about a live master, and every refusal. The real rollback, the READ ONLY
 * transaction and the key constraints are exercised on PostgreSQL in
 * test/integration/jne-master-import.int-spec.ts.
 */

const BASE_URL = 'https://jne-production.example:10205';
const PRODUCTION_TARGET: TargetEnvironment = { jneEnvironment: 'production', jneBaseUrl: BASE_URL, jneOriginCode: 'BDO10000' };
const SANDBOX_TARGET: TargetEnvironment = { jneEnvironment: 'sandbox', jneOriginCode: 'BDO10000' };
const OLD_FETCH = new Date('2026-09-02T02:40:46.000Z');
const NEW_FETCH = '2026-10-30T07:50:43.065Z';

interface Row {
  id: string;
  code: string;
  kind: JneLocationKind;
  source: JneDataSource;
  rawName: string;
  normalizedName: string;
  parsedChild: string;
  parsedParent: string | null;
  partCount: number;
  isActive: boolean;
  sourceFetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface MappingFixture {
  id: string;
  code: string;
  kind?: JneLocationKind;
  status: string;
  isActive?: boolean;
}

/** Copies on every read and restores on a throw, as a transaction would. */
function memoryStore(rows: Row[], mappings: MappingFixture[] = []) {
  const state = { rows: rows.map((r) => ({ ...r })) };
  const statements: string[] = [];
  const calls = { writes: 0, transactions: [] as Array<string | undefined>, wheres: [] as unknown[] };
  let readOnly = false;
  let tick = 0;
  let failAfterWrites = Number.POSITIVE_INFINITY;
  let beforeWrite: (() => void) | undefined;
  let corruptAfterWrite: ((all: Row[]) => void) | undefined;

  const write = () => {
    if (readOnly) throw new Error('cannot execute in a read-only transaction');
    beforeWrite?.();
    calls.writes += 1;
    if (calls.writes > failAfterWrites) throw new Error('simulated write failure');
  };
  const ids = (where: { id?: unknown }) => (where.id as { in: string[] }).in;

  const store: MasterStore = {
    jneLocation: {
      findMany: async () => state.rows.map((r) => ({ ...r })),
      createMany: async ({ data }) => {
        write();
        for (const d of data) {
          if (state.rows.some((r) => r.code === d.code && r.kind === d.kind)) throw new Error('Unique constraint failed on (code, kind)');
          state.rows.push({ ...(d as unknown as Row), id: `new-${d.code}`, updatedAt: new Date(++tick) });
        }
        return { count: data.length };
      },
      update: async ({ where, data }) => {
        write();
        calls.wheres.push(where);
        const row = state.rows.find((r) => r.id === where.id && r.kind === where.kind);
        if (!row) throw new Error('Record to update not found');
        Object.assign(row, data, { updatedAt: new Date(++tick) });
        return row;
      },
      updateMany: async ({ where, data }) => {
        write();
        calls.wheres.push(where);
        const wanted = new Set(ids(where));
        const hit = state.rows.filter((r) => wanted.has(r.id) && r.kind === where.kind && (where.isActive === undefined || r.isActive === where.isActive));
        for (const r of hit) Object.assign(r, data, { updatedAt: new Date(++tick) });
        corruptAfterWrite?.(state.rows);
        return { count: hit.length };
      },
    },
    jneDistrictMapping: {
      findMany: async () =>
        mappings.map((m) => ({
          id: m.id,
          status: m.status,
          isActive: m.isActive ?? true,
          district: { code: `d-${m.id}`, name: `District ${m.id}` },
          jneLocation: { code: m.code, kind: m.kind ?? 'DESTINATION' },
        })),
    },
    $executeRawUnsafe: async (q) => {
      statements.push(q);
      if (q === 'SET TRANSACTION READ ONLY') readOnly = true;
      return 0;
    },
    $transaction: async (fn, options) => {
      calls.transactions.push(options?.isolationLevel);
      const copy = state.rows.map((r) => ({ ...r }));
      try {
        return await fn(store);
      } catch (err) {
        state.rows = copy;
        throw err;
      } finally {
        readOnly = false;
      }
    },
  };
  return {
    store,
    state,
    statements,
    calls,
    failAfter: (n: number) => (failAfterWrites = n),
    onBeforeWrite: (fn: () => void) => (beforeWrite = fn),
    onAfterWrite: (fn: (all: Row[]) => void) => (corruptAfterWrite = fn),
    upsertRow: (r: Row) => state.rows.push(r),
    mappings,
  };
}

let seq = 0;
const row = (code: string, rawName: string, over: Partial<Row> = {}): Row => ({
  id: `id-${++seq}`,
  code,
  kind: 'DESTINATION',
  source: 'SANDBOX',
  rawName,
  normalizedName: rawName,
  parsedChild: rawName,
  parsedParent: null,
  partCount: 1,
  isActive: true,
  sourceFetchedAt: OLD_FETCH,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});
// As in the real master: the origin is SANDBOX-sourced, and stays that way.
const originRow = (over: Partial<Row> = {}) => row('BDO10000', 'BANDUNG', { kind: 'ORIGIN', ...over });

const raw = (code: string, name: string): JneMasterRaw => ({ City_Code: code, City_Name: name });

interface Fixture {
  rows: unknown[];
  kind?: JneLocationKind;
  source?: JneDataSource;
  metadata?: Record<string, unknown> | null;
  target?: TargetEnvironment;
  reviewedRenames?: PlanInput['reviewedRenames'];
  require?: boolean;
  expected?: SnapshotExpectations;
}

/** A plan builder, the way main() assembles one. `expected` defaults to the snapshot's true values. */
function builder(f: Fixture) {
  const kind = f.kind ?? 'DESTINATION';
  const source = f.source ?? 'PRODUCTION';
  const bytes = Buffer.from(JSON.stringify({ detail: f.rows }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const defaults = {
    environment: source,
    request: { method: 'POST', url: `${BASE_URL}${kind === 'ORIGIN' ? '/insert/getorigin' : '/insert/getdestination'}` },
    httpStatus: 200,
    bodySha256: sha256,
    requestStartedUtc: NEW_FETCH,
  };
  const metadata = f.metadata === null ? null : JSON.stringify({ ...defaults, ...f.metadata });
  const snapshot = loadSnapshot(bytes, metadata, kind, source);
  const expected = { records: f.rows.length, uniqueCodes: snapshot.inspection.uniqueCodes, sha256, ...f.expected };
  const input = (state: MasterState, planSha256?: string): PlanInput => ({
    kind,
    source,
    sha256: snapshot.sha256,
    sourceFetchedAt: snapshot.sourceFetchedAt,
    inspection: snapshot.inspection,
    seeds: snapshot.seeds,
    reviewedRenames: f.reviewedRenames ?? [],
    provenance: snapshot.provenance,
    target: f.target ?? (source === 'PRODUCTION' ? PRODUCTION_TARGET : SANDBOX_TARGET),
    expected: { ...expected, ...(planSha256 ? { planSha256 } : {}) },
    requireExpectations: f.require ?? false,
    ...state,
  });
  return { input, build: (state: MasterState, planSha256?: string) => planMasterImport(input(state, planSha256)) };
}

/** Plan, then import with the plan hash a reviewer would have copied from the dry run. */
async function imported(m: ReturnType<typeof memoryStore>, f: Fixture) {
  const b = builder(f);
  const dry = await runLiveDryRun(m.store, (s) => b.build(s), () => {});
  const confirmed = builder({ ...f, require: true });
  return runImport(m.store, (s) => confirmed.build(s, dry.planSha256), () => {});
}

const codesOf = (blockers: Array<{ code: string }>) => blockers.map((b) => b.code);

describe('live dry run', () => {
  const master = () => [row('BDO10001', 'SAME,BANDUNG'), row('BDO10002', 'OLD,BANDUNG'), row('BDO10003', 'GONE,BANDUNG'), originRow()];
  const incoming = [raw('BDO10001', 'SAME,BANDUNG'), raw('BDO10002', 'NEW,BANDUNG'), raw('BDO10004', 'ADDED,BANDUNG')];

  it('writes nothing, and asks PostgreSQL to refuse a write', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(m.state.rows);
    await runLiveDryRun(m.store, (s) => builder({ rows: incoming }).build(s), () => {});
    expect(m.statements).toEqual(['SET TRANSACTION READ ONLY']);
    expect(m.calls.writes).toBe(0);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('classifies unchanged, new, changed and missing, and prints each count', async () => {
    const m = memoryStore(master());
    const lines: string[] = [];
    const plan = await runLiveDryRun(m.store, (s) => builder({ rows: incoming }).build(s), (l) => lines.push(l));

    expect(plan.created.map((s) => s.code)).toEqual(['BDO10004']);
    expect(plan.updated.map((u) => [u.code, u.changes])).toEqual([
      ['BDO10001', ['source', 'sourceFetchedAt']],
      ['BDO10002', ['rawName', 'source', 'sourceFetchedAt']],
    ]);
    expect(plan.missing.map((x) => x.code)).toEqual(['BDO10003']);
    expect(lines.join('\n')).toMatch(/new\s+: 1[\s\S]*changed\s+: 2 \(rawName 1, source 2, reactivated 0\)[\s\S]*missing\s+: 1 \(1 active; reported, not deactivated\)/);
  });

  it('compares source as well as name: identical name, same fetch, other source is a change', () => {
    const plan = builder({ rows: [raw('BDO10001', 'SAME,BANDUNG')] }).build({
      existing: [row('BDO10001', 'SAME,BANDUNG', { sourceFetchedAt: new Date(NEW_FETCH) })],
      mappings: [],
    });
    expect(plan.unchanged).toBe(0);
    expect(plan.updated[0].changes).toEqual(['source']);
  });

  it('counts a row of the same source, name and fetch time as unchanged', () => {
    const plan = builder({ rows: [raw('BDO10001', 'SAME,BANDUNG')] }).build({
      existing: [row('BDO10001', 'SAME,BANDUNG', { source: 'PRODUCTION', sourceFetchedAt: new Date(NEW_FETCH) })],
      mappings: [],
    });
    expect(plan.unchanged).toBe(1);
    expect(plan.updated).toEqual([]);
  });

  it('diffs against one kind but reports the overlap with the other', () => {
    const plan = builder({ rows: [raw('BDO10000', 'BANDUNG, KAB BANDUNG')] }).build({ existing: [originRow()], mappings: [] });
    expect(plan.created.map((s) => s.code)).toEqual(['BDO10000']);
    expect(plan.alsoInOtherKind).toBe(1);
    expect(plan.missing).toEqual([]);
  });

  it('never treats the other kind as missing', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A,BANDUNG')] }).build({ existing: [originRow(), row('CGK10000', 'JAKARTA', { kind: 'ORIGIN' })], mappings: [] });
    expect(plan.missing).toEqual([]);
  });

  it('reports blockers without stopping, so one run shows everything to fix', async () => {
    const m = memoryStore([]);
    const lines: string[] = [];
    const plan = await runLiveDryRun(m.store, (s) => builder({ rows: [raw('BDO10001', 'A'), raw('BDO10001', 'B'), raw('bad', 'C')], metadata: null }).build(s), (l) => lines.push(l));
    expect(codesOf(plan.blockers)).toEqual(expect.arrayContaining(['INVALID_RECORDS', 'DUPLICATE_CODES', 'PROVENANCE_MISSING']));
    expect(lines.join('\n')).toContain('an import would be refused');
  });
});

describe('new and changed destinations', () => {
  it('inserts a new code with its raw name verbatim and the snapshot provenance', async () => {
    const m = memoryStore([originRow()]);
    await imported(m, { rows: [raw('BDO10004', ' ADDED , BANDUNG ')] });
    const added = m.state.rows.find((r) => r.code === 'BDO10004')!;
    expect(added.rawName).toBe(' ADDED , BANDUNG ');
    expect(added.source).toBe('PRODUCTION');
    expect(added.sourceFetchedAt.toISOString()).toBe(NEW_FETCH);
  });

  it('updates a changed name in place, keeping the id a mapping references', async () => {
    const existing = row('BDO10002', 'OLD,BANDUNG');
    const m = memoryStore([existing, originRow()]);
    await imported(m, { rows: [raw('BDO10002', 'NEW,KAB.BANDUNG')] });
    const after = m.state.rows.find((r) => r.code === 'BDO10002')!;
    expect(after.id).toBe(existing.id);
    expect(after.rawName).toBe('NEW,KAB.BANDUNG');
    expect(after.normalizedName).toBe('NEW,KAB.BANDUNG');
    expect(after.parsedParent).toBe('KAB.BANDUNG');
  });

  it('recomputes derived fields only for rows whose name changed', async () => {
    const m = memoryStore([row('BDO10001', 'SAME,BANDUNG', { parsedChild: 'SENTINEL' }), originRow()]);
    await imported(m, { rows: [raw('BDO10001', 'SAME,BANDUNG')] });
    expect(m.state.rows.find((r) => r.code === 'BDO10001')!.parsedChild).toBe('SENTINEL');
  });

  it('reactivates a code the snapshot lists again, and says so', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A,BANDUNG')] }).build({ existing: [row('BDO10001', 'A,BANDUNG', { isActive: false })], mappings: [] });
    expect(plan.updated[0].changes).toContain('isActive');
  });
});

describe('missing destinations', () => {
  it('an import never deactivates a code absent from the snapshot', async () => {
    const m = memoryStore([row('BDO10001', 'A,BANDUNG'), row('BDO10003', 'GONE,BANDUNG'), originRow()]);
    const result = await imported(m, { rows: [raw('BDO10001', 'A,BANDUNG')] });
    expect(result.code).toBe(0);
    const gone = m.state.rows.find((r) => r.code === 'BDO10003')!;
    expect(gone.isActive).toBe(true);
    expect(gone.source).toBe('SANDBOX');
    expect(result.plan.missing.map((x) => x.code)).toEqual(['BDO10003']);
  });

  it('survives a far smaller snapshot with every row intact', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`BDO2${String(i).padStart(4, '0')}`, `R${i}`));
    const m = memoryStore([...rows, originRow()]);
    await imported(m, { rows: [raw('BDO10002', 'ONE,BANDUNG')] });
    expect(m.state.rows.filter((r) => r.kind === 'DESTINATION' && r.isActive)).toHaveLength(101);
  });

  it('does not call a test code missing when the snapshot lists it', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A,BANDUNG'), raw('TEST', 'TEST')] }).build({
      existing: [row('BDO10001', 'A,BANDUNG'), row('TEST', 'TEST', { isActive: false })],
      mappings: [],
    });
    expect(plan.missing).toEqual([]);
    expect(plan.testCodes).toEqual(['TEST']);
  });

  it('warns about a MATCHED mapping on a missing code', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A,BANDUNG')] }).build({
      existing: [row('BDO10001', 'A,BANDUNG'), row('BDO10003', 'GONE,BANDUNG')],
      mappings: [{ id: 'm1', status: 'MATCHED', isActive: true, districtCode: 'd', districtName: 'D', jneCode: 'BDO10003', kind: 'DESTINATION' }],
    });
    expect(plan.missing[0].activeMatched).toBe(1);
    expect(plan.mappingImpact[0].state).toBe('MISSING');
    expect(plan.warnings.join()).toContain('BDO10003 has 1 active MATCHED');
  });
});

describe('explicit deactivation of missing codes', () => {
  const importedMaster = () => [
    row('BDO10001', 'A,BANDUNG', { source: 'PRODUCTION', sourceFetchedAt: new Date(NEW_FETCH) }),
    row('BDO10003', 'GONE,BANDUNG'),
    row('BDO10005', 'ALSO GONE,BANDUNG'),
    row('BDO10006', 'MAPPED,BANDUNG'),
    row('BDO10007', 'INACTIVE,BANDUNG', { isActive: false }),
    originRow(),
  ];
  const f: Fixture = { rows: [raw('BDO10001', 'A,BANDUNG')], require: true };
  const request = (codes: string[], over = {}) => ({ codes, expectCount: codes.length, reason: 'absent from production master', operator: 'ops', confirm: true, ...over });
  const run = (m: ReturnType<typeof memoryStore>, codes: string[], over = {}, fixture = f) =>
    runDeactivateMissing(m.store, (s) => builder(fixture).build(s), request(codes, over), () => {});

  it('deactivates exactly the listed codes and keeps the rows', async () => {
    const m = memoryStore(importedMaster());
    const r = await run(m, ['BDO10003']);
    expect(r).toMatchObject({ code: 0, written: 1 });
    expect(m.state.rows.find((x) => x.code === 'BDO10003')!.isActive).toBe(false);
    expect(m.state.rows.find((x) => x.code === 'BDO10005')!.isActive).toBe(true);
    expect(m.state.rows).toHaveLength(importedMaster().length);
    expect(m.calls.transactions).toEqual(['Serializable']);
  });

  it('is a dry run unless confirmed', async () => {
    const m = memoryStore(importedMaster());
    const r = await run(m, ['BDO10003'], { confirm: false });
    expect(r).toMatchObject({ code: 0, written: 0 });
    expect(r.targets.map((t) => t.code)).toEqual(['BDO10003']);
    expect(m.calls.writes).toBe(0);
  });

  it.each([
    ['a wrong expected count', ['BDO10003'], { expectCount: 9 }, /--expect-count is 9/],
    ['no expected count', ['BDO10003'], { expectCount: undefined }, /--expect-count is absent/],
    ['no reason', ['BDO10003'], { reason: 'short' }, /--reason/],
    ['no operator', ['BDO10003'], { operator: ' ' }, /--operator/],
    ['a code in the snapshot', ['BDO10001'], {}, /BDO10001 is not a missing code/],
    ['an unknown code', ['ZZZ10000'], {}, /ZZZ10000 is not a missing code/],
    ['an already inactive code', ['BDO10007'], {}, /already inactive/],
  ])('refuses %s, and refuses the whole list', async (_label, codes, over, message) => {
    const m = memoryStore(importedMaster());
    const r = await run(m, ['BDO10005', ...codes], { expectCount: 'expectCount' in over ? over.expectCount : codes.length + 1, ...over });
    expect(r.code).toBe(4);
    expect(r.refused.join('\n')).toMatch(message);
    expect(m.calls.writes).toBe(0);
    expect(m.calls.transactions).toEqual([]);
  });

  it.each([['MATCHED'], ['REVIEW_REQUIRED']])('refuses a code with an active %s mapping', async (status) => {
    const m = memoryStore(importedMaster(), [{ id: 'm1', code: 'BDO10006', status }]);
    const r = await run(m, ['BDO10006']);
    expect(r.code).toBe(4);
    expect(r.refused.join()).toMatch(/retire them first with deactivate-jne-mappings/);
  });

  it('refuses until the snapshot has been imported', async () => {
    const m = memoryStore([row('BDO10001', 'A,BANDUNG'), row('BDO10003', 'GONE,BANDUNG'), originRow()]);
    const r = await run(m, ['BDO10003']);
    expect(r.refused.join()).toMatch(/import this snapshot first/);
  });

  it('refuses without the reviewed count and checksum', async () => {
    const m = memoryStore(importedMaster());
    const r = await run(m, ['BDO10003'], {}, { ...f, expected: { sha256: 'f'.repeat(64) } });
    expect(r.refused.join()).toMatch(/CHECKSUM_MISMATCH/);
  });

  it('a mapping appearing between the check and the write rolls everything back', async () => {
    const mappings: MappingFixture[] = [];
    const m = memoryStore(importedMaster(), mappings);
    const real = m.store.$transaction;
    m.store.$transaction = (fn, o) => {
      mappings.push({ id: 'late', code: 'BDO10003', status: 'MATCHED' });
      return real(fn, o);
    };
    await expect(run(m, ['BDO10003'])).rejects.toThrow(MasterChangedError);
    expect(m.state.rows.find((x) => x.code === 'BDO10003')!.isActive).toBe(true);
  });
});

describe('existing MATCHED mappings', () => {
  const matched = (over: Partial<MappingFixture> = {}): MappingFixture => ({ id: 'm1', code: 'BDO10002', status: 'MATCHED', ...over });
  const renamed = [raw('BDO10002', 'COBLONG,BANDUNG')];
  const master = () => [row('BDO10002', 'COBLONG,BANDUG'), originRow()];

  it('blocks a rename under an active MATCHED mapping, and writes nothing', async () => {
    const m = memoryStore(master(), [matched()]);
    const result = await imported(m, { rows: renamed });
    expect(result.code).toBe(4);
    expect(codesOf(result.plan.blockers)).toEqual(['RENAME_NEEDS_REVIEW']);
    expect(m.calls.writes).toBe(0);
    expect(m.state.rows[0].rawName).toBe('COBLONG,BANDUG');
  });

  it('allows it once a reviewer lists that exact change', async () => {
    const m = memoryStore(master(), [matched()]);
    const result = await imported(m, { rows: renamed, reviewedRenames: [{ code: 'BDO10002', from: 'COBLONG,BANDUG', to: 'COBLONG,BANDUNG' }] });
    expect(result.code).toBe(0);
    expect(m.state.rows[0].rawName).toBe('COBLONG,BANDUNG');
  });

  it.each([
    ['another old name', { code: 'BDO10002', from: 'COBLONG', to: 'COBLONG,BANDUNG' }],
    ['another new name', { code: 'BDO10002', from: 'COBLONG,BANDUG', to: 'SOMETHING ELSE' }],
    ['a name differing only in whitespace', { code: 'BDO10002', from: 'COBLONG,BANDUG ', to: 'COBLONG,BANDUNG' }],
  ])('a review naming %s approves nothing', async (_label, review) => {
    const m = memoryStore(master(), [matched()]);
    const result = await imported(m, { rows: renamed, reviewedRenames: [review] });
    expect(result.code).toBe(4);
    expect(codesOf(result.plan.blockers)).toEqual(expect.arrayContaining(['RENAME_NEEDS_REVIEW', 'REVIEWED_RENAME_NOT_PENDING']));
  });

  describe('the two real renames', () => {
    const realMaster = () => [originRow(), row('BDO10054', 'COBLONG,BANDUG'), row('BDO10050', 'BOJONGLOA KIDUL,BANDUG')];
    const realSnapshot = [raw('BDO10054', 'COBLONG,BANDUNG'), raw('BDO10050', 'BOJONGLOA KIDUL,BANDUNG')];
    const realMappings = (): MappingFixture[] => [
      { id: 'coblong', code: 'BDO10054', status: 'MATCHED' },
      { id: 'bojongloa', code: 'BDO10050', status: 'MATCHED' },
    ];
    const coblong = { code: 'BDO10054', from: 'COBLONG,BANDUG', to: 'COBLONG,BANDUNG' };
    const bojongloa = { code: 'BDO10050', from: 'BOJONGLOA KIDUL,BANDUG', to: 'BOJONGLOA KIDUL,BANDUNG' };

    it('block the import with no review, naming both', async () => {
      const m = memoryStore(realMaster(), realMappings());
      const result = await imported(m, { rows: realSnapshot });
      expect(result.code).toBe(4);
      expect(result.plan.blockers.map((b) => b.detail.slice(0, 8)).sort()).toEqual(['BDO10050', 'BDO10054']);
      expect(codesOf(result.plan.blockers)).toEqual(['RENAME_NEEDS_REVIEW', 'RENAME_NEEDS_REVIEW']);
      expect(m.calls.writes).toBe(0);
    });

    it.each([
      ['Coblong', [coblong], 'BDO10050'],
      ['Bojongloa Kidul', [bojongloa], 'BDO10054'],
    ])('reviewing only %s still blocks the other', async (_label, reviewedRenames, left) => {
      const m = memoryStore(realMaster(), realMappings());
      const result = await imported(m, { rows: realSnapshot, reviewedRenames });
      expect(result.code).toBe(4);
      expect(result.plan.blockers.map((b) => b.detail.slice(0, 8))).toEqual([left]);
      expect(m.calls.writes).toBe(0);
    });

    it('a review with the two codes swapped approves neither', async () => {
      const swapped = [
        { code: 'BDO10054', from: bojongloa.from, to: bojongloa.to },
        { code: 'BDO10050', from: coblong.from, to: coblong.to },
      ];
      const m = memoryStore(realMaster(), realMappings());
      const result = await imported(m, { rows: realSnapshot, reviewedRenames: swapped });
      expect(result.code).toBe(4);
      expect(codesOf(result.plan.blockers)).toEqual(expect.arrayContaining(['RENAME_NEEDS_REVIEW', 'REVIEWED_RENAME_NOT_PENDING']));
      expect(m.calls.writes).toBe(0);
    });

    it('proceed only when both are reviewed exactly, and the mappings stay as they were', async () => {
      const mappings = realMappings();
      const m = memoryStore(realMaster(), mappings);
      const result = await imported(m, { rows: realSnapshot, reviewedRenames: [coblong, bojongloa] });
      expect(result.code).toBe(0);
      expect(m.state.rows.find((r) => r.code === 'BDO10054')!.rawName).toBe('COBLONG,BANDUNG');
      expect(mappings).toEqual(realMappings());
    });
  });

  it('refuses a review of a rename that is not happening', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A,BANDUNG')], reviewedRenames: [{ code: 'BDO10001', from: 'X', to: 'Y' }] }).build({ existing: [row('BDO10001', 'A,BANDUNG')], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('REVIEWED_RENAME_NOT_PENDING');
  });

  it('does not block on an inactive MATCHED mapping', () => {
    const plan = builder({ rows: renamed }).build({
      existing: master(),
      mappings: [{ id: 'm', status: 'MATCHED', isActive: false, districtCode: 'd', districtName: 'D', jneCode: 'BDO10002', kind: 'DESTINATION' }],
    });
    expect(codesOf(plan.blockers)).not.toContain('RENAME_NEEDS_REVIEW');
  });

  it('a relabel with an unchanged name needs no review, and the mapping keeps its location id', async () => {
    const existing = row('BDO10002', 'CIBIRU,BANDUNG');
    const m = memoryStore([existing, originRow()], [matched()]);
    const result = await imported(m, { rows: [raw('BDO10002', 'CIBIRU,BANDUNG')] });
    expect(result.code).toBe(0);
    expect(result.plan.mappingImpact[0].state).toBe('RELABELLED');
    expect(m.state.rows.find((r) => r.code === 'BDO10002')!.id).toBe(existing.id);
  });

  it('reports a mapping impact row for every mapping of this kind and none of the other', () => {
    const plan = builder({ rows: [raw('BDO10002', 'A')] }).build({
      existing: [row('BDO10002', 'A')],
      mappings: [
        { id: 'a', status: 'MATCHED', isActive: true, districtCode: 'd', districtName: 'D', jneCode: 'BDO10002', kind: 'DESTINATION' },
        { id: 'b', status: 'MATCHED', isActive: true, districtCode: 'e', districtName: 'E', jneCode: 'BDO10002', kind: 'ORIGIN' },
      ],
    });
    expect(plan.mappingImpact.map((m) => m.mappingId)).toEqual(['a']);
  });

  it('the store has no mapping write method: the tool cannot touch one', () => {
    const m = memoryStore([]);
    expect(Object.keys(m.store.jneDistrictMapping)).toEqual(['findMany']);
    const src = readFileSync(join(__dirname, '../../prisma/tools/import-jne-master.ts'), 'utf8');
    expect(src).not.toMatch(/jneDistrictMapping\.(create|update|delete|upsert)/);
    expect(src).not.toMatch(/\.upsert\(|\.delete(Many)?\(/);
  });
});

describe('existing REVIEW_REQUIRED mappings', () => {
  const review: MappingFixture = { id: 'r1', code: 'BDO10038', status: 'REVIEW_REQUIRED' };

  it('a rename under a pending mapping is flagged, not blocked', async () => {
    const m = memoryStore([row('BDO10038', 'CICADAS,BANDUNG'), originRow()], [review]);
    const result = await imported(m, { rows: [raw('BDO10038', 'ANTAPANI,BANDUNG')] });
    expect(result.code).toBe(0);
    expect(result.plan.warnings.join()).toContain('BDO10038 renamed under a REVIEW_REQUIRED mapping');
    expect(result.plan.mappingImpact[0]).toMatchObject({ status: 'REVIEW_REQUIRED', state: 'RENAMED', fromRawName: 'CICADAS,BANDUNG', toRawName: 'ANTAPANI,BANDUNG' });
  });

  it('stays exactly as it was', async () => {
    const mappings = [{ ...review }];
    const m = memoryStore([row('BDO10038', 'CICADAS,BANDUNG'), originRow()], mappings);
    await imported(m, { rows: [raw('BDO10038', 'CICADAS,BANDUNG')] });
    expect(mappings).toEqual([review]);
  });
});

describe('invalid and duplicate records', () => {
  it.each([
    ['a malformed code', [raw('bdo10001', 'A')], 'INVALID_RECORDS'],
    ['a blank name', [raw('BDO10001', '  ')], 'INVALID_RECORDS'],
    ['a non-object row', ['x'], 'INVALID_RECORDS'],
    ['a duplicate code', [raw('BDO10001', 'A'), raw('BDO10001', 'B')], 'DUPLICATE_CODES'],
  ])('%s refuses the whole snapshot', async (_label, rows, blocker) => {
    const m = memoryStore([originRow()]);
    const result = await imported(m, { rows: [raw('BDO10009', 'FINE'), ...rows] });
    expect(result.code).toBe(4);
    expect(codesOf(result.plan.blockers)).toContain(blocker);
    expect(m.state.rows).toHaveLength(1);
  });

  it('a known test code is excluded, reported, and does not refuse the snapshot', async () => {
    const m = memoryStore([originRow()]);
    const result = await imported(m, { rows: [raw('BDO10009', 'FINE'), raw('TEST', 'TEST')] });
    expect(result.code).toBe(0);
    expect(result.plan.testCodes).toEqual(['TEST']);
    expect(m.state.rows.some((r) => r.code === 'TEST')).toBe(false);
  });

  it('counts records and unique codes separately', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A'), raw('BDO10001', 'B'), raw('BDO10002', 'C')] }).build({ existing: [], mappings: [] });
    expect(plan.records).toBe(3);
    expect(plan.uniqueCodes).toBe(2);
    expect(plan.accepted).toBe(1);
  });
});

describe('atomic import', () => {
  const master = () => [row('BDO10001', 'A,BANDUNG'), row('BDO10002', 'OLD,BANDUNG'), originRow()];
  const rows = [raw('BDO10001', 'A,BANDUNG'), raw('BDO10002', 'NEW,BANDUNG'), raw('BDO10004', 'ADDED,BANDUNG')];
  const reviewedDry = async (m: ReturnType<typeof memoryStore>) => (await runLiveDryRun(m.store, (s) => builder({ rows }).build(s), () => {})).planSha256;

  it('uses one Serializable transaction', async () => {
    const m = memoryStore(master());
    await imported(m, { rows });
    expect(m.calls.transactions).toEqual(['RepeatableRead', 'Serializable']);
  });

  it('rolls everything back when a write fails midway', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(m.state.rows);
    const hash = await reviewedDry(m);
    m.failAfter(2);
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow('simulated write failure');
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('rolls back when the post-write check finds a wrong row', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(m.state.rows);
    const hash = await reviewedDry(m);
    m.onAfterWrite((all) => (all.find((r) => r.code === 'BDO10002')!.rawName = 'CORRUPTED'));
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(/post-write check failed/);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('rolls back when a row outside the plan changes during the write', async () => {
    const existing = [...master(), row('BDO10003', 'GONE,BANDUNG')];
    const m = memoryStore(existing);
    const before = JSON.stringify(m.state.rows);
    const hash = await reviewedDry(m);
    m.onAfterWrite((all) => (all.find((r) => r.code === 'BDO10003')!.rawName = 'TOUCHED'));
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(/a row outside the plan changed/);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('rolls back when a missing code is deactivated during the write', async () => {
    const m = memoryStore([...master(), row('BDO10003', 'GONE,BANDUNG')]);
    const hash = await reviewedDry(m);
    m.onAfterWrite((all) => (all.find((r) => r.code === 'BDO10003')!.isActive = false));
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(/a row outside the plan changed/);
    expect(m.state.rows.find((r) => r.code === 'BDO10003')!.isActive).toBe(true);
  });

  it('rolls back when a row is added outside the plan', async () => {
    const m = memoryStore(master());
    const hash = await reviewedDry(m);
    m.onAfterWrite((all) => all.push(row('BDO10008', 'UNPLANNED,BANDUNG')));
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(/row count is not the planned one/);
  });

  it('rolls back when a mapping changes during the write', async () => {
    const mappings: MappingFixture[] = [{ id: 'm1', code: 'BDO10001', status: 'MATCHED' }];
    const m = memoryStore(master(), mappings);
    const before = JSON.stringify(m.state.rows);
    const hash = await reviewedDry(m);
    m.onAfterWrite(() => (mappings[0].isActive = false));
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(/a mapping changed/);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('aborts when the master changed after the plan', async () => {
    const m = memoryStore(master());
    const hash = await reviewedDry(m);
    const real = m.store.$transaction;
    m.store.$transaction = (fn, o) => {
      m.upsertRow(row('BDO10008', 'CONCURRENT,BANDUNG'));
      return real(fn, o);
    };
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(MasterChangedError);
    expect(m.calls.writes).toBe(0);
  });

  it('aborts when a mapping changed after the plan', async () => {
    const mappings: MappingFixture[] = [];
    const m = memoryStore(master(), mappings);
    const hash = await reviewedDry(m);
    const real = m.store.$transaction;
    m.store.$transaction = (fn, o) => {
      mappings.push({ id: 'late', code: 'BDO10002', status: 'MATCHED' });
      return real(fn, o);
    };
    await expect(runImport(m.store, (s) => builder({ rows, require: true }).build(s, hash), () => {})).rejects.toThrow(MasterChangedError);
    expect(m.calls.writes).toBe(0);
  });

  it('refuses a plan other than the one reviewed', async () => {
    const m = memoryStore(master());
    const result = await runImport(m.store, (s) => builder({ rows, require: true }).build(s, 'not-the-plan'), () => {});
    expect(result.code).toBe(4);
    expect(codesOf(result.plan.blockers)).toEqual(['PLAN_MISMATCH']);
  });

  it('refuses a write with no plan hash at all', async () => {
    const m = memoryStore(master());
    const result = await runImport(m.store, (s) => builder({ rows, require: true }).build(s), () => {});
    expect(codesOf(result.plan.blockers)).toEqual(['EXPECTED_VALUE_REQUIRED']);
    expect(m.calls.writes).toBe(0);
  });

  it('writes in chunks without losing a row', async () => {
    const many = Array.from({ length: 1201 }, (_, i) => row(`BDO3${String(i).padStart(4, '0')}`, `R${i}`));
    const m = memoryStore([...many, originRow()]);
    const result = await imported(m, { rows: many.map((r) => raw(r.code, r.rawName)) });
    expect(result.written).toBe(1201);
    expect(m.calls.writes).toBe(3);
    expect(m.state.rows.filter((r) => r.source === 'PRODUCTION')).toHaveLength(1201);
  });
});

describe('source provenance', () => {
  it('a PRODUCTION import without metadata is refused: the flag alone is not evidence', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], metadata: null }).build({ existing: [originRow()], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('PROVENANCE_MISSING');
  });

  it.each([
    ['another environment', { environment: 'SANDBOX' }, /metadata says SANDBOX/],
    ['a failed capture', { httpStatus: 500 }, /HTTP 500/],
    ['another file', { bodySha256: 'a'.repeat(64) }, /checksum does not match/],
    ['the wrong method', { request: { method: 'GET', url: `${BASE_URL}/insert/getdestination` } }, /method GET/],
    ['the origin path', { request: { method: 'POST', url: `${BASE_URL}/insert/getorigin` } }, /not the DESTINATION master/],
    ['plain http', { request: { method: 'POST', url: 'http://jne-production.example:10205/insert/getdestination' } }, /not https/],
    ['the known sandbox endpoint', { request: { method: 'POST', url: 'https://apiv2.jne.co.id:10202/insert/getdestination' } }, /known sandbox endpoint/],
    ['an endpoint this environment does not use', { request: { method: 'POST', url: 'https://apiv2.jne.co.id:10102/insert/getdestination' } }, /differs from JNE_BASE_URL/],
    ['a URL that does not parse', { request: { method: 'POST', url: 'not a url' } }, /does not parse/],
  ])('refuses metadata naming %s', (_label, metadata, message) => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], metadata }).build({ existing: [originRow()], mappings: [] });
    const invalid = plan.blockers.filter((b) => b.code === 'PROVENANCE_INVALID').map((b) => b.detail);
    expect(invalid.join()).toMatch(message);
  });

  it('refuses a PRODUCTION snapshot in a database that is not production', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], target: { ...PRODUCTION_TARGET, jneEnvironment: 'sandbox' } }).build({ existing: [originRow()], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('TARGET_ENVIRONMENT_MISMATCH');
  });

  it('treats an unset JNE_ENVIRONMENT as sandbox, as the application does', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], target: { ...PRODUCTION_TARGET, jneEnvironment: undefined } }).build({ existing: [originRow()], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('TARGET_ENVIRONMENT_MISMATCH');
  });

  it('refuses a SANDBOX snapshot in a production database', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], source: 'SANDBOX', target: PRODUCTION_TARGET }).build({ existing: [], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('TARGET_ENVIRONMENT_MISMATCH');
  });

  it('a later SANDBOX import can never turn a production master back', async () => {
    const m = memoryStore([row('BDO10001', 'PROD,BANDUNG', { source: 'PRODUCTION', sourceFetchedAt: new Date(NEW_FETCH) }), originRow()]);
    const before = JSON.stringify(m.state.rows);
    const result = await imported(m, { rows: [raw('BDO10001', 'SANDBOX,BANDUNG')], source: 'SANDBOX', metadata: null });
    expect(result.code).toBe(4);
    expect(codesOf(result.plan.blockers)).toContain('SANDBOX_INTO_PRODUCTION_MASTER');
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('refuses SANDBOX even for codes the production master does not have', () => {
    const plan = builder({ rows: [raw('BDO19999', 'NEW,BANDUNG')], source: 'SANDBOX', metadata: null }).build({
      existing: [row('BDO10001', 'P', { source: 'PRODUCTION', sourceFetchedAt: new Date(NEW_FETCH) })],
      mappings: [],
    });
    expect(codesOf(plan.blockers)).toContain('SANDBOX_INTO_PRODUCTION_MASTER');
  });

  it('a SANDBOX import into a sandbox master stays allowed, with no metadata', async () => {
    const m = memoryStore([row('BDO10001', 'OLD')]);
    const result = await imported(m, { rows: [raw('BDO10001', 'OLD')], source: 'SANDBOX', metadata: { environment: 'SANDBOX' } });
    expect(result.code).toBe(0);
  });

  it('refuses a snapshot older than the rows it would overwrite', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')] }).build({
      existing: [originRow(), row('BDO10001', 'A', { source: 'PRODUCTION', sourceFetchedAt: new Date('2027-01-01T00:00:00Z') })],
      mappings: [],
    });
    expect(codesOf(plan.blockers)).toContain('STALE_SNAPSHOT');
  });

  it('refuses to record the import time as the fetch time', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')], source: 'SANDBOX', metadata: null }).build({ existing: [], mappings: [] });
    expect(plan.sourceFetchedAt).toBeNull();
    expect(codesOf(plan.blockers)).toContain('FETCH_TIME_UNKNOWN');
  });

  it('takes the fetch time from a 61C capture envelope', () => {
    const body = JSON.stringify({ detail: [raw('BDO10001', 'A')] });
    const capture = Buffer.from(JSON.stringify({ status: 200, headers: [['date', 'Wed, 02 Sep 2026 02:40:46 GMT']], text: body }));
    expect(loadSnapshot(capture, null, 'DESTINATION', 'SANDBOX').sourceFetchedAt).toBe('2026-09-02T02:40:46.000Z');
  });

  it('reads the fetch-metadata.json shape and refuses an incomplete one', () => {
    const complete = { environment: 'PRODUCTION', request: { method: 'POST', url: 'https://x/y' }, httpStatus: 200, bodySha256: 'a', requestStartedUtc: NEW_FETCH };
    expect(parseProvenance(JSON.stringify(complete)).url).toBe('https://x/y');
    expect(() => parseProvenance(JSON.stringify({ ...complete, bodySha256: undefined }))).toThrow(/no bodySha256/);
    expect(() => parseProvenance(JSON.stringify({ ...complete, request: {} }))).toThrow(/no method/);
  });

  it('hashes the file as stored, byte for byte', () => {
    const bytes = Buffer.from('{ "detail" : [ {"City_Code":"BDO10001","City_Name":"A "} ] }\n');
    expect(loadSnapshot(bytes, null, 'DESTINATION', 'SANDBOX').sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('re-import idempotency', () => {
  const rows = [raw('BDO10001', 'A,BANDUNG'), raw('BDO10002', 'B,BANDUNG')];

  it('a second run of the same snapshot writes nothing and moves no updatedAt', async () => {
    const m = memoryStore([row('BDO10001', 'A,BANDUNG'), originRow()]);
    await imported(m, { rows });
    const after = JSON.stringify(m.state.rows);
    const writes = m.calls.writes;

    const again = await imported(m, { rows });
    expect(again).toMatchObject({ code: 0, written: 0 });
    expect(again.plan.unchanged).toBe(2);
    expect(m.calls.writes).toBe(writes);
    expect(JSON.stringify(m.state.rows)).toBe(after);
  });

  it('repeating an import with its own review file is still a no-op', async () => {
    const reviewedRenames = [{ code: 'BDO10002', from: 'OLD,BANDUNG', to: 'B,BANDUNG' }];
    const m = memoryStore([row('BDO10001', 'A,BANDUNG'), row('BDO10002', 'OLD,BANDUNG'), originRow()], [{ id: 'm1', code: 'BDO10002', status: 'MATCHED' }]);
    expect((await imported(m, { rows, reviewedRenames })).code).toBe(0);
    expect(await imported(m, { rows, reviewedRenames })).toMatchObject({ code: 0, written: 0 });
  });

  it('a repeat run opens no write transaction', async () => {
    const m = memoryStore([row('BDO10001', 'A,BANDUNG'), originRow()]);
    await imported(m, { rows });
    m.calls.transactions.length = 0;
    await imported(m, { rows });
    expect(m.calls.transactions).toEqual(['RepeatableRead']);
  });

  it.each([
    ['environment', { jneEnvironment: 'sandbox' }],
    ['endpoint', { jneBaseUrl: 'https://other.example:1' }],
    ['origin code', { jneOriginCode: 'CGK10000' }],
  ])('binds the plan hash to the target %s: a staging review proves nothing in production', (_label, over) => {
    const state = (): MasterState => ({ existing: [{ ...row('BDO10001', 'A'), id: 'same-id-in-both' }], mappings: [] });
    const production = builder({ rows }).build(state()).planSha256;
    expect(builder({ rows, target: { ...PRODUCTION_TARGET, ...over } }).build(state()).planSha256).not.toBe(production);
  });

  it.each([
    ['snapshot', { rows: [raw('BDO10001', 'A,BANDUNG'), raw('BDO10002', 'B,BANDUNG'), raw('BDO10003', 'C')] }],
    ['kind', { kind: 'ORIGIN' as const }],
    ['source', { source: 'SANDBOX' as const, metadata: { environment: 'SANDBOX' }, target: PRODUCTION_TARGET }],
    ['fetch time', { metadata: { requestStartedUtc: '2026-10-31T00:00:00.000Z' } }],
  ])('binds the plan hash to the %s', (_label, over) => {
    const state = (): MasterState => ({ existing: [{ ...row('BDO10001', 'A'), id: 'fixed' }], mappings: [] });
    expect(builder({ rows, ...over }).build(state()).planSha256).not.toBe(builder({ rows }).build(state()).planSha256);
  });

  it('gives the same plan hash for the same state, and another for any difference', () => {
    const state = (): MasterState => ({ existing: [row('BDO10001', 'A')].map((r) => ({ ...r, id: 'fixed' })), mappings: [] });
    const b = builder({ rows });
    expect(b.build(state()).planSha256).toBe(b.build(state()).planSha256);
    expect(builder({ rows: [...rows, raw('BDO10003', 'C')] }).build(state()).planSha256).not.toBe(b.build(state()).planSha256);
  });
});

describe('destination-only refresh', () => {
  const dest = [raw('BDO10001', 'A,BANDUNG'), raw('BDO10002', 'NEW NAME,BANDUNG'), raw('BDO10004', 'ADDED,BANDUNG')];
  const master = () => [
    originRow(),
    row('BDO10001', 'ORIGIN NAME OF A SHARED CODE', { kind: 'ORIGIN' }),
    row('CGK10000', 'JAKARTA', { kind: 'ORIGIN' }),
    row('BDO10001', 'A,BANDUNG'),
    row('BDO10002', 'OLD NAME,BANDUNG'),
    row('BDO10003', 'GONE,BANDUNG'),
  ];
  const origins = (m: ReturnType<typeof memoryStore>) => m.state.rows.filter((r) => r.kind === 'ORIGIN');
  const fingerprint = (m: ReturnType<typeof memoryStore>) => locationFingerprint(origins(m));

  it('imports DESTINATION as PRODUCTION while ORIGIN stays SANDBOX', async () => {
    const m = memoryStore(master());
    const result = await imported(m, { rows: dest });
    expect(result).toMatchObject({ code: 0, written: 3 });
    expect(result.plan.blockers).toEqual([]);
    expect(m.state.rows.filter((r) => r.kind === 'DESTINATION' && r.code !== 'BDO10003').every((r) => r.source === 'PRODUCTION')).toBe(true);
    expect(origins(m).every((r) => r.source === 'SANDBOX')).toBe(true);
  });

  it('leaves every ORIGIN row identical: fingerprint, values, ids and timestamps', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(origins(m));
    const fp = fingerprint(m);
    const result = await imported(m, { rows: dest });
    expect(JSON.stringify(origins(m))).toBe(before);
    expect(fingerprint(m)).toBe(fp);
    expect(result.plan.protectedFingerprint).toBe(fp);
    expect(result.plan).toMatchObject({ protectedKind: 'ORIGIN' });
    expect(result.plan.protectedRows).toHaveLength(3);
  });

  it('a code in both masters changes only its DESTINATION row', async () => {
    const m = memoryStore(master());
    await imported(m, { rows: [raw('BDO10001', 'RENAMED,BANDUNG')] });
    expect(m.state.rows.find((r) => r.code === 'BDO10001' && r.kind === 'DESTINATION')!.rawName).toBe('RENAMED,BANDUNG');
    expect(m.state.rows.find((r) => r.code === 'BDO10001' && r.kind === 'ORIGIN')!.rawName).toBe('ORIGIN NAME OF A SHARED CODE');
  });

  it('every plan row and every write is confined to DESTINATION', async () => {
    const m = memoryStore(master());
    const result = await imported(m, { rows: dest });
    const originIds = new Set(origins(m).map((r) => r.id));
    expect(result.plan.created.every((s) => s.kind === 'DESTINATION')).toBe(true);
    expect(result.plan.updated.every((u) => u.seed.kind === 'DESTINATION' && !originIds.has(u.id))).toBe(true);
    expect(result.plan.missing.every((x) => !originIds.has(x.id))).toBe(true);
    expect(m.calls.wheres.length).toBeGreaterThan(0);
    for (const w of m.calls.wheres) expect(w).toMatchObject({ kind: 'DESTINATION' });
  });

  it('a write that would hit an ORIGIN row matches nothing, and rolls back', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(m.state.rows);
    const hash = (await runLiveDryRun(m.store, (s) => builder({ rows: dest }).build(s), () => {})).planSha256;
    const origin = origins(m)[0];
    const hostile = (s: MasterState) => {
      const plan = builder({ rows: dest, require: true }).build(s, hash);
      const relabel = plan.updated.find((u) => !u.changes.includes('rawName'))!;
      relabel.id = origin.id;
      return plan;
    };
    await expect(runImport(m.store, hostile, () => {})).rejects.toThrow(/updated \d+ of \d+ row/);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it('rolls everything back when ORIGIN moves during the transaction', async () => {
    const m = memoryStore(master());
    const before = JSON.stringify(m.state.rows);
    const hash = (await runLiveDryRun(m.store, (s) => builder({ rows: dest }).build(s), () => {})).planSha256;
    m.onAfterWrite((all) => (all.find((r) => r.kind === 'ORIGIN' && r.code === 'BDO10000')!.source = 'PRODUCTION'));
    await expect(runImport(m.store, (s) => builder({ rows: dest, require: true }).build(s, hash), () => {})).rejects.toThrow(/the ORIGIN master changed/);
    expect(JSON.stringify(m.state.rows)).toBe(before);
  });

  it.each([
    ['rawName', { rawName: 'X' }],
    ['source', { source: 'PRODUCTION' as const }],
    ['isActive', { isActive: false }],
    ['sourceFetchedAt', { sourceFetchedAt: new Date(NEW_FETCH) }],
    ['updatedAt', { updatedAt: new Date(99) }],
    ['id', { id: 'another' }],
  ])('a change to ORIGIN %s after review invalidates the plan', (_field, over) => {
    const existing = master();
    const b = builder({ rows: dest });
    const reviewed = b.build({ existing, mappings: [] }).planSha256;
    const changed = existing.map((r) => (r.kind === 'ORIGIN' && r.code === 'CGK10000' ? { ...r, ...over } : r));
    expect(b.build({ existing: changed, mappings: [] }).planSha256).not.toBe(reviewed);
  });

  it('an ORIGIN row added or removed after review invalidates the plan', () => {
    const b = builder({ rows: dest });
    const reviewed = b.build({ existing: master(), mappings: [] }).planSha256;
    expect(b.build({ existing: [...master(), row('MDN10000', 'MEDAN', { kind: 'ORIGIN' })], mappings: [] }).planSha256).not.toBe(reviewed);
    expect(b.build({ existing: master().filter((r) => r.code !== 'CGK10000'), mappings: [] }).planSha256).not.toBe(reviewed);
  });

  it('the fingerprint ignores read order', () => {
    const rows = master();
    expect(locationFingerprint([...rows].reverse())).toBe(locationFingerprint(rows));
  });

  it('an ORIGIN change between review and write refuses the import', async () => {
    const m = memoryStore(master());
    const hash = (await runLiveDryRun(m.store, (s) => builder({ rows: dest }).build(s), () => {})).planSha256;
    m.state.rows.find((r) => r.code === 'CGK10000')!.rawName = 'CHANGED';
    const result = await runImport(m.store, (s) => builder({ rows: dest, require: true }).build(s, hash), () => {});
    expect(codesOf(result.plan.blockers)).toEqual(['PLAN_MISMATCH']);
    expect(m.calls.writes).toBe(0);
  });

  it('BDO10000 stays active and the real boot validator passes after the import', async () => {
    const m = memoryStore(master());
    await imported(m, { rows: dest });
    const origin = origins(m).find((r) => r.code === 'BDO10000')!;
    expect(origin.isActive).toBe(true);
    const prisma = { jneLocation: { count: async () => origins(m).length, findFirst: async () => origins(m).find((r) => r.code === 'BDO10000') ?? null } };
    await expect(new JneOriginBootValidator(prisma as never).validate({ enabled: true, originCode: 'BDO10000' })).resolves.toBeUndefined();
  });

  it.each([
    ['absent', [], /BDO10000 is absent/],
    ['inactive', [originRow({ isActive: false })], /BDO10000 is inactive/],
  ])('refuses while the origin code is %s, since the backend would not start', (_label, existing, message) => {
    const plan = builder({ rows: dest }).build({ existing, mappings: [] });
    expect(plan.blockers.find((b) => b.code === 'ORIGIN_CODE_NOT_ACTIVE')!.detail).toMatch(message);
  });

  it('an origin code present only as a DESTINATION does not satisfy it', () => {
    const plan = builder({ rows: dest }).build({ existing: [row('BDO10000', 'BANDUNG')], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('ORIGIN_CODE_NOT_ACTIVE');
  });

  it('accepts the origin code from either source: availability is what matters', () => {
    for (const source of ['SANDBOX', 'PRODUCTION'] as const) {
      const plan = builder({ rows: dest }).build({ existing: [originRow({ source })], mappings: [] });
      expect(codesOf(plan.blockers)).not.toContain('ORIGIN_CODE_NOT_ACTIVE');
    }
  });

  it('a production import needs JNE_ORIGIN_CODE to be set', () => {
    const plan = builder({ rows: dest, target: { ...PRODUCTION_TARGET, jneOriginCode: ' ' } }).build({ existing: master(), mappings: [] });
    expect(codesOf(plan.blockers)).toContain('ORIGIN_CODE_UNKNOWN');
  });

  it('keeps MATCHED rename protection with the ORIGIN master left as it is', async () => {
    const m = memoryStore(master(), [{ id: 'm1', code: 'BDO10002', status: 'MATCHED' }]);
    const blocked = await imported(m, { rows: dest });
    expect(blocked.code).toBe(4);
    expect(codesOf(blocked.plan.blockers)).toEqual(['RENAME_NEEDS_REVIEW']);
    expect(m.calls.writes).toBe(0);

    const reviewedRenames = [{ code: 'BDO10002', from: 'OLD NAME,BANDUNG', to: 'NEW NAME,BANDUNG' }];
    expect((await imported(m, { rows: dest, reviewedRenames })).code).toBe(0);
  });

  it('leaves a mapping on an ORIGIN row alone', async () => {
    const mappings: MappingFixture[] = [{ id: 'o1', code: 'BDO10000', kind: 'ORIGIN', status: 'MATCHED' }];
    const m = memoryStore(master(), mappings);
    const result = await imported(m, { rows: dest });
    expect(result.code).toBe(0);
    expect(result.plan.mappingImpact).toEqual([]);
    expect(mappings).toEqual([{ id: 'o1', code: 'BDO10000', kind: 'ORIGIN', status: 'MATCHED' }]);
  });

  it('keeps every source restriction', () => {
    const existing = master();
    const metadata = { environment: 'SANDBOX' };
    const noEvidence = builder({ rows: dest, metadata: null }).build({ existing, mappings: [] });
    expect(codesOf(noEvidence.blockers)).toContain('PROVENANCE_MISSING');
    const wrongTarget = builder({ rows: dest, target: { ...PRODUCTION_TARGET, jneEnvironment: 'sandbox' } }).build({ existing, mappings: [] });
    expect(codesOf(wrongTarget.blockers)).toContain('TARGET_ENVIRONMENT_MISMATCH');
    const sandboxOnProduction = builder({ rows: dest, source: 'SANDBOX', metadata, target: PRODUCTION_TARGET }).build({ existing, mappings: [] });
    expect(codesOf(sandboxOnProduction.blockers)).toContain('TARGET_ENVIRONMENT_MISMATCH');
  });

  it('a later SANDBOX destination import cannot turn the refreshed master back', async () => {
    const m = memoryStore(master());
    await imported(m, { rows: dest });
    const after = JSON.stringify(m.state.rows);
    const result = await imported(m, { rows: dest, source: 'SANDBOX', metadata: { environment: 'SANDBOX' } });
    expect(codesOf(result.plan.blockers)).toContain('SANDBOX_INTO_PRODUCTION_MASTER');
    expect(JSON.stringify(m.state.rows)).toBe(after);
  });

  it('is idempotent, and a repeat run leaves ORIGIN and DESTINATION alone', async () => {
    const m = memoryStore(master());
    await imported(m, { rows: dest });
    const after = JSON.stringify(m.state.rows);
    const writes = m.calls.writes;
    expect(await imported(m, { rows: dest })).toMatchObject({ code: 0, written: 0 });
    expect(m.calls.writes).toBe(writes);
    expect(JSON.stringify(m.state.rows)).toBe(after);
  });

  it('deactivation cannot reach an ORIGIN row', async () => {
    const m = memoryStore(master());
    await imported(m, { rows: dest });
    const fp = fingerprint(m);
    const refused = await runDeactivateMissing(
      m.store,
      (s) => builder({ rows: dest, require: true }).build(s),
      { codes: ['CGK10000'], expectCount: 1, reason: 'not a destination code', operator: 'ops', confirm: true },
      () => {},
    );
    expect(refused.code).toBe(4);
    expect(refused.refused.join()).toMatch(/CGK10000 is not a missing code/);
    const done = await runDeactivateMissing(
      m.store,
      (s) => builder({ rows: dest, require: true }).build(s),
      { codes: ['BDO10003'], expectCount: 1, reason: 'absent from the production master', operator: 'ops', confirm: true },
      () => {},
    );
    expect(done.written).toBe(1);
    expect(fingerprint(m)).toBe(fp);
  });

  it('records the protected set in the reports', () => {
    const plan = builder({ rows: dest }).build({ existing: master(), mappings: [] });
    const out = join(mkdtempSync(join(tmpdir(), 'jne-master-')), 'r');
    writeReports(out, plan, null);
    expect(JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8'))).toMatchObject({ protectedKind: 'ORIGIN', protectedRows: 3, protectedFingerprint: plan.protectedFingerprint });
    expect(readFileSync(join(out, 'protected-kind-snapshot.csv'), 'utf8')).toContain('BDO10000,ORIGIN,SANDBOX,BANDUNG');
    rmSync(join(out, '..'), { recursive: true, force: true });
  });

  it('an ORIGIN snapshot, if one is ever used, must still contain the origin code', () => {
    const plan = builder({ rows: [raw('CGK10000', 'JAKARTA')], kind: 'ORIGIN' }).build({ existing: [], mappings: [] });
    expect(codesOf(plan.blockers)).toContain('ORIGIN_CODE_NOT_IN_SNAPSHOT');
    expect(plan).toMatchObject({ protectedKind: 'DESTINATION' });
  });
});

describe('row count and checksum guard', () => {
  const rows = [raw('BDO10001', 'A'), raw('BDO10002', 'B')];
  const plan = (expected: SnapshotExpectations, require = false) => builder({ rows, expected, require }).build({ existing: [originRow()], mappings: [] });

  it('passes on the reviewed values, whatever size they are', () => {
    expect(plan({ records: 2, uniqueCodes: 2 }).blockers).toEqual([]);
  });

  it.each([
    ['record count', { records: 3 }, 'RECORD_COUNT_MISMATCH'],
    ['unique-code count', { uniqueCodes: 3 }, 'UNIQUE_CODE_COUNT_MISMATCH'],
    ['checksum', { sha256: 'a'.repeat(64) }, 'CHECKSUM_MISMATCH'],
  ])('refuses a wrong %s', (_label, expected, blocker) => {
    expect(codesOf(plan(expected).blockers)).toEqual([blocker]);
  });

  it('a write needs every expected value', () => {
    const b = builder({ rows, require: true });
    const blockers = planMasterImport({ ...b.input({ existing: [originRow()], mappings: [] }), expected: {} }).blockers;
    expect(blockers.map((x) => x.detail).join()).toMatch(/--expect-records, --expect-unique-codes, --expect-sha256/);
  });

  it('a dry run needs none of them', () => {
    const b = builder({ rows });
    const blockers = planMasterImport({ ...b.input({ existing: [originRow()], mappings: [] }), expected: {} }).blockers;
    expect(blockers).toEqual([]);
  });

  it('a snapshot of the old sandbox size earns no special treatment', () => {
    const big = Array.from({ length: 8322 }, (_, i) => raw(`BDO${String(100000 + i)}`, `R${i}`));
    const blockers = planMasterImport({ ...builder({ rows: big }).input({ existing: [originRow()], mappings: [] }), expected: { records: 7644 } }).blockers;
    expect(codesOf(blockers)).toContain('RECORD_COUNT_MISMATCH');
  });
});

describe('the command line', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jne-master-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = ['--snapshot', 's.json', '--source', 'PRODUCTION'];

  it.each(Object.keys(RETIRED_FLAGS))('%s is refused, not ignored', (flag) => {
    expect(() => parseArgs([...base, flag])).toThrow(/no row-count override/);
  });

  it('parses every expected value', () => {
    const o = parseArgs([...base, '--expect-records', '7644', '--expect-unique-codes', '7644', '--expect-sha256', 'abc', '--expect-plan', 'def']);
    expect(o.expected).toEqual({ records: 7644, uniqueCodes: 7644, sha256: 'abc', planSha256: 'def' });
  });

  it.each([['--expect-records'], ['--expect-unique-codes'], ['--expect-count']])('%s must be a whole number', (flag) => {
    expect(() => parseArgs([...base, flag, '12x'])).toThrow(/whole number/);
  });

  it('a database run needs a report directory; --confirm and --live-dry-run exclude each other', () => {
    expect(usageProblem(parseArgs([...base, '--live-dry-run']))).toMatch(/--report-dir/);
    expect(usageProblem(parseArgs([...base, '--confirm']))).toMatch(/--report-dir/);
    expect(usageProblem(parseArgs([...base, '--deactivate-missing', 'c.csv']))).toMatch(/--report-dir/);
    expect(usageProblem(parseArgs([...base, '--live-dry-run', '--confirm', '--report-dir', 'r']))).toMatch(/mutually exclusive/);
    expect(usageProblem(parseArgs([...base, '--reviewed-renames', 'r.csv', '--report-dir', 'r', '--confirm']))).toMatch(/--reviewed-by/);
  });

  const writeSnapshot = () => {
    const { writeFileSync } = require('fs') as typeof import('fs');
    const bytes = Buffer.from(JSON.stringify({ detail: [raw('BDO10001', 'A,BANDUNG')] }));
    const snapshot = join(dir, 'raw.json');
    const metadata = join(dir, 'meta.json');
    writeFileSync(snapshot, bytes);
    writeFileSync(
      metadata,
      JSON.stringify({
        environment: 'PRODUCTION',
        request: { method: 'POST', url: `${BASE_URL}/insert/getdestination` },
        httpStatus: 200,
        bodySha256: createHash('sha256').update(bytes).digest('hex'),
        requestStartedUtc: NEW_FETCH,
      }),
    );
    return { snapshot, metadata, sha: createHash('sha256').update(bytes).digest('hex') };
  };
  const env = { JNE_ENVIRONMENT: 'production', JNE_BASE_URL: BASE_URL, JNE_ORIGIN_CODE: 'BDO10000' };

  it('the default mode never opens a database', async () => {
    const { snapshot } = writeSnapshot();
    const open = jest.fn();
    await expect(main(['--snapshot', snapshot, '--source', 'PRODUCTION'], open, env, () => {})).resolves.toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it('--confirm with blockers exits 4, writes nothing, and still leaves its report', async () => {
    const { snapshot, metadata } = writeSnapshot();
    const m = memoryStore([originRow()]);
    const report = join(dir, 'report');
    const code = await main(['--snapshot', snapshot, '--source', 'PRODUCTION', '--metadata', metadata, '--report-dir', report, '--confirm'], () => ({ store: m.store, close: async () => {} }), env, () => {});
    expect(code).toBe(4);
    expect(m.calls.writes).toBe(0);
    expect(JSON.parse(readFileSync(join(report, 'plan.json'), 'utf8')).blockers.map((b: { code: string }) => b.code)).toContain('EXPECTED_VALUE_REQUIRED');
  });

  it('runs the dry run and the import end to end, keeping a hash-linked record', async () => {
    const { snapshot, metadata, sha } = writeSnapshot();
    const m = memoryStore([originRow()]);
    const open = () => ({ store: m.store, close: async () => {} });
    const args = ['--snapshot', snapshot, '--source', 'PRODUCTION', '--metadata', metadata];

    const dry = join(dir, 'dry');
    await expect(main([...args, '--live-dry-run', '--report-dir', dry], open, env, () => {})).resolves.toBe(0);
    const reviewed = JSON.parse(readFileSync(join(dry, 'plan.json'), 'utf8'));
    expect(reviewed).toMatchObject({ action: 'LIVE_DRY_RUN', snapshotSha256: sha, new: 1, blockers: [] });
    expect(m.calls.writes).toBe(0);

    const done = join(dir, 'done');
    const expectations = ['--expect-records', '1', '--expect-unique-codes', '1', '--expect-sha256', sha, '--expect-plan', reviewed.planSha256];
    await expect(main([...args, ...expectations, '--report-dir', done, '--confirm'], open, env, () => {})).resolves.toBe(0);
    expect(JSON.parse(readFileSync(join(done, 'plan.json'), 'utf8'))).toMatchObject({ action: 'IMPORT', written: 1, planSha256: reviewed.planSha256 });
    expect(m.state.rows.find((r) => r.code === 'BDO10001')!.source).toBe('PRODUCTION');
  });

  it('refuses an existing report directory before touching the database', async () => {
    const { snapshot, metadata } = writeSnapshot();
    const open = jest.fn();
    await expect(main(['--snapshot', snapshot, '--source', 'PRODUCTION', '--metadata', metadata, '--live-dry-run', '--report-dir', dir], open, env, () => {})).resolves.toBe(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('writeReports never overwrites a directory, and holds no credential field', () => {
    const plan = builder({ rows: [raw('BDO10001', 'A')] }).build({ existing: [row('BDO10002', 'GONE')], mappings: [] });
    const out = join(dir, 'reports');
    writeReports(out, plan, null);
    expect(() => writeReports(out, plan, null)).toThrow(/already exists/);
    expect(readFileSync(join(out, 'missing.csv'), 'utf8')).toContain('BDO10002,SANDBOX,GONE,true,0,0');
    expect(existsSync(join(out, 'renames-to-review.csv'))).toBe(true);
    expect(readFileSync(join(out, 'plan.json'), 'utf8')).not.toMatch(/api_key|username/i);
  });

  it('reads the review and code lists strictly', () => {
    expect(parseReviewedRenames('code,from_raw_name,to_raw_name\nBDO10054,"COBLONG,BANDUG","COBLONG,BANDUNG"\n')).toEqual([{ code: 'BDO10054', from: 'COBLONG,BANDUG', to: 'COBLONG,BANDUNG' }]);
    expect(() => parseReviewedRenames('code,from_raw_name,to_raw_name\nA,x,y\nA,x,z\n')).toThrow(/twice/);
    expect(parseCodeList('code,source\nBDO10003,SANDBOX\n')).toEqual(['BDO10003']);
    expect(() => parseCodeList('code\nA\nA\n')).toThrow(/repeats A/);
  });
});
