/**
 * Nationwide JNE destination mapping: manifest validation, batch proposal and the
 * separate approval step. Offline - every store is a fake; nothing reaches a
 * database or JNE.
 */
import { toCsv } from '../../prisma/tools/csv';
import { APPROVAL_TIMEOUT_MS, decideApprovals, runApprovals, type ApprovalStore } from '../../prisma/tools/approve-jne-mappings';
import { ManifestChangedError, parseImportArgs, runImport, WRITE_CHUNK, type ImportStore } from '../../prisma/tools/import-jne-mapping-manifest';
import {
  MANIFEST_COLUMNS,
  parseManifest,
  validateManifest,
  type ExistingMapping,
  type ManifestContext,
  type ManifestDistrict,
  type ManifestLocation,
} from '../../prisma/tools/jne-mapping-manifest';

const NOW = () => '2026-10-29T09:00:00.000Z';
const RATIONALE = 'All six kelurahan and postal codes carry this tariff code in the list.';

const district = (code: string, name: string, over: Partial<ManifestDistrict> = {}): ManifestDistrict => ({
  id: `dist-${code}`,
  code,
  name,
  isActive: true,
  city: { id: 'city-kab-bandung', name: 'Kabupaten Bandung', type: 'REGENCY', isActive: true, province: { id: 'prov-jabar', name: 'Jawa Barat' } },
  ...over,
});
const location = (code: string, over: Partial<ManifestLocation> = {}): ManifestLocation => ({
  id: `loc-${code}-${over.kind ?? 'DESTINATION'}`,
  code,
  kind: 'DESTINATION',
  source: 'SANDBOX',
  isActive: true,
  rawName: `${code} NAME,SOREANG`,
  parsedChild: `${code} NAME`,
  parsedParent: 'SOREANG',
  ...over,
});

const DISTRICTS = [
  district('32.04.08', 'Bojongsoang'),
  district('32.04.05', 'Cileunyi'),
  district('32.04.09', 'Margahayu'),
  district('32.04.99', 'Retired', { isActive: false }),
  district('32.04.98', 'Retired City', { city: { id: 'c', name: 'Old', type: 'REGENCY', isActive: false, province: { id: 'p', name: 'P' } } }),
];
const LOCATIONS = [
  location('BDO10104', { rawName: 'BOJONG SOANG,SOREANG', parsedChild: 'BOJONG SOANG' }),
  location('BDO10109'),
  location('BDO10121'),
  location('BDO10000', { kind: 'ORIGIN' }),
  location('BDO10199', { isActive: false }),
  location('BDO10198', { source: 'OTHER' }),
];

function ctx(existing: ExistingMapping[] = []): ManifestContext {
  return {
    districts: new Map(DISTRICTS.map((d) => [d.code, d])),
    locations: LOCATIONS,
    existing,
    allowedSources: ['SANDBOX', 'PRODUCTION'],
    manifestId: 'sha256:test',
    now: NOW,
  };
}

type Row = Partial<Record<(typeof MANIFEST_COLUMNS)[number], string>>;
const row = (districtCode: string, jneCode: string, over: Row = {}): Row => ({
  district_code: districtCode,
  jne_code: jneCode,
  confidence: 'STRONG',
  source_dataset: 'JNE list_dest',
  source_version: 'sha256:361f00e8271d107f',
  evidence: 'kelurahan+postal 6/6 matched',
  rationale: RATIONALE,
  ...over,
});
const manifest = (...rows: Row[]) => toCsv(MANIFEST_COLUMNS, rows);
const decide = (text: string, existing: ExistingMapping[] = []) => validateManifest(parseManifest(text), ctx(existing));
const outcomeOf = (text: string, existing: ExistingMapping[] = []) =>
  decide(text, existing).rows.map((r) => `${r.entry.districtCode}:${r.outcome}${r.outcome === 'ACCEPT' ? '' : `:${r.reason}`}`);

describe('validateManifest', () => {
  it('accepts a valid row as a REVIEW_REQUIRED / MANUAL candidate carrying full provenance', () => {
    const report = decide(manifest(row('32.04.08', 'BDO10104')));
    expect(report).toMatchObject({ accepted: 1, noop: 0, rejected: 0 });
    const r = report.rows[0];
    if (r.outcome !== 'ACCEPT') throw new Error('expected ACCEPT');
    expect(r.write).toMatchObject({ districtId: 'dist-32.04.08', jneLocationId: 'loc-BDO10104-DESTINATION', status: 'REVIEW_REQUIRED', method: 'MANUAL', confidence: 'STRONG' });
    expect(r.write.evidence).toMatchObject({
      internalDistrictName: 'Bojongsoang',
      internalCityType: 'REGENCY',
      jneCode: 'BDO10104',
      jneRawName: 'BOJONG SOANG,SOREANG',
      matchingMethod: 'MANUAL',
      aliasRationale: RATIONALE,
      expectedJneParent: null,
      manifestId: 'sha256:test',
      manifestRecord: 1,
      sourceDataset: 'JNE list_dest',
      sourceVersion: 'sha256:361f00e8271d107f',
      evidenceSummary: 'kelurahan+postal 6/6 matched',
      confidence: 'STRONG',
      resolvedAt: '2026-10-29T09:00:00.000Z',
    });
  });

  it.each([
    ['an unknown district', row('99.99.99', 'BDO10104'), 'UNKNOWN_DISTRICT'],
    ['an inactive district', row('32.04.99', 'BDO10104'), 'INACTIVE_DISTRICT'],
    ['a district in an inactive city', row('32.04.98', 'BDO10104'), 'INACTIVE_DISTRICT'],
    ['a code missing from the JNE master', row('32.04.08', 'BDO19999'), 'JNE_CODE_NOT_IN_MASTER'],
    ['a code that exists only as an ORIGIN', row('32.04.08', 'BDO10000'), 'JNE_CODE_ORIGIN_ONLY'],
    ['an inactive JNE location', row('32.04.08', 'BDO10199'), 'JNE_LOCATION_INACTIVE'],
    ['a JNE location from a source not allowed', row('32.04.08', 'BDO10198'), 'JNE_SOURCE_NOT_ALLOWED'],
    ['a malformed district code', row('32.4.8', 'BDO10104'), 'MALFORMED_ROW'],
    ['a malformed JNE code', row('32.04.08', 'bdo1010'), 'MALFORMED_ROW'],
    ['an AMBIGUOUS confidence', row('32.04.08', 'BDO10104', { confidence: 'AMBIGUOUS' }), 'INVALID_CONFIDENCE'],
    ['missing provenance', row('32.04.08', 'BDO10104', { source_version: '' }), 'MISSING_PROVENANCE'],
    ['missing evidence', row('32.04.08', 'BDO10104', { evidence: '' }), 'MISSING_PROVENANCE'],
    ['a rationale too short to re-check', row('32.04.08', 'BDO10104', { rationale: 'looks right' }), 'RATIONALE_TOO_SHORT'],
  ])('rejects %s', (_what, r, reason) => {
    const report = decide(manifest(r));
    expect(report.rejected).toBe(1);
    expect(report.rows[0]).toMatchObject({ outcome: 'REJECT', reason });
  });

  it('rejects every row of a district listed with two different codes - never picks one', () => {
    expect(outcomeOf(manifest(row('32.04.08', 'BDO10104'), row('32.04.08', 'BDO10109')))).toEqual([
      '32.04.08:REJECT:CONFLICTING_ROWS',
      '32.04.08:REJECT:CONFLICTING_ROWS',
    ]);
  });

  it('accepts the first of two identical rows and rejects the duplicate', () => {
    expect(outcomeOf(manifest(row('32.04.08', 'BDO10104'), row('32.04.08', 'BDO10104')))).toEqual(['32.04.08:ACCEPT', '32.04.08:REJECT:DUPLICATE_ROW']);
  });

  describe('against existing mappings', () => {
    const existing = (status: string, jneCode: string, isActive = true): ExistingMapping => ({
      districtId: 'dist-32.04.08',
      jneLocationId: `loc-${jneCode}-DESTINATION`,
      jneCode,
      status,
      isActive,
    });
    it.each([
      ['already approved for this code: no-op (rerun is idempotent)', existing('MATCHED', 'BDO10104'), 'NOOP:ALREADY_APPROVED'],
      ['already pending for this code: no-op (rerun is idempotent)', existing('REVIEW_REQUIRED', 'BDO10104'), 'NOOP:ALREADY_PENDING'],
      ['approved for a different code: never overwritten', existing('MATCHED', 'BDO10109'), 'REJECT:APPROVED_FOR_DIFFERENT_CODE'],
      ['pending for a different code: would be promoted together', existing('REVIEW_REQUIRED', 'BDO10109'), 'REJECT:PENDING_FOR_DIFFERENT_CODE'],
      ['an inactive row for this exact pair: reviving it is a decision', existing('MATCHED', 'BDO10104', false), 'REJECT:EXISTING_ROW_NOT_REUSABLE'],
      ['an AMBIGUOUS row for this exact pair', existing('AMBIGUOUS', 'BDO10104'), 'REJECT:EXISTING_ROW_NOT_REUSABLE'],
    ])('%s', (_what, m, expected) => {
      expect(outcomeOf(manifest(row('32.04.08', 'BDO10104')), [m])).toEqual([`32.04.08:${expected}`]);
    });

    it('an inactive approval for another code does not block a new candidate', () => {
      expect(outcomeOf(manifest(row('32.04.08', 'BDO10104')), [existing('MATCHED', 'BDO10109', false)])).toEqual(['32.04.08:ACCEPT']);
    });
  });

  it('is deterministic: rows are decided and reported in district-code order', () => {
    const text = manifest(row('32.04.09', 'BDO10121'), row('32.04.05', 'BDO10109'), row('32.04.08', 'BDO10104'));
    expect(decide(text).rows.map((r) => r.entry.districtCode)).toEqual(['32.04.05', '32.04.08', '32.04.09']);
    expect(JSON.stringify(decide(text))).toBe(JSON.stringify(decide(text)));
  });
});

// ------------------------------------------------------------------ import CLI

function importStore(existing: Array<{ districtId: string; jneLocationId: string; status: string; isActive: boolean; jneLocation: { code: string } }> = []) {
  const writes: unknown[][] = [];
  const store: ImportStore = {
    district: { findMany: async () => DISTRICTS },
    jneLocation: { findMany: async () => LOCATIONS },
    jneDistrictMapping: {
      // Applies `districtId: { in }` the way Prisma does.
      findMany: async (args) => {
        const ids = (args as { where: { districtId: { in: string[] } } }).where.districtId.in;
        return existing.filter((m) => ids.includes(m.districtId));
      },
      createMany: async ({ data }) => {
        writes.push(data);
        return { count: data.length };
      },
    },
    $transaction: async (fn) => fn(store),
  };
  return { store, writes };
}
const quiet = () => undefined;
const OPTS = { confirm: true, allowPartial: false, allowedSources: ['SANDBOX', 'PRODUCTION'], manifestId: 'sha256:test' };

describe('the import source is explicit', () => {
  it('--allow-source has no default and accepts only known sources', () => {
    expect(parseImportArgs(['--manifest', 'm.csv']).allowedSources).toEqual([]);
    expect(parseImportArgs(['--manifest', 'm.csv', '--allow-source', 'PRODUCTION']).allowedSources).toEqual(['PRODUCTION']);
    expect(parseImportArgs(['--manifest', 'm.csv', '--allow-source', 'sandbox, production']).allowedSources).toEqual(['SANDBOX', 'PRODUCTION']);
    expect(() => parseImportArgs(['--manifest', 'm.csv', '--allow-source', 'SANDBOX,STAGING'])).toThrow(/accepts SANDBOX, PRODUCTION; got STAGING/);
    expect(parseImportArgs(['--manifest', 'm.csv', '--confirm']).confirm).toBe(true);
    expect(parseImportArgs(['--manifest', 'm.csv']).confirm).toBe(false);
  });

  it('without an accepted source nothing is read, validated or written - even with --confirm', async () => {
    const { store, writes } = importStore();
    const findMany = jest.spyOn(store.district, 'findMany');
    const res = await runImport(store, manifest(row('32.04.08', 'BDO10104')), { ...OPTS, allowedSources: [] }, quiet, NOW);
    expect(res).toMatchObject({ code: 2, written: 0, report: { accepted: 0, rejected: 0 } });
    expect(findMany).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('PRODUCTION only refuses a sandbox-sourced code; SANDBOX must be named to accept it', async () => {
    const prod = await runImport(importStore().store, manifest(row('32.04.08', 'BDO10104')), { ...OPTS, confirm: false, allowedSources: ['PRODUCTION'] }, quiet, NOW);
    expect(prod.report.byReason).toEqual({ JNE_SOURCE_NOT_ALLOWED: 1 });
    const sandbox = await runImport(importStore().store, manifest(row('32.04.08', 'BDO10104')), { ...OPTS, confirm: false, allowedSources: ['SANDBOX'] }, quiet, NOW);
    expect(sandbox.report.accepted).toBe(1);
  });
});

describe('runImport', () => {
  it('is a dry run unless --confirm', async () => {
    const { store, writes } = importStore();
    const res = await runImport(store, manifest(row('32.04.08', 'BDO10104')), { ...OPTS, confirm: false }, quiet, NOW);
    expect(res).toMatchObject({ code: 0, written: 0 });
    expect(res.report.accepted).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('with --confirm writes only REVIEW_REQUIRED / MANUAL rows - never MATCHED, never a reviewer', async () => {
    const { store, writes } = importStore();
    const res = await runImport(store, manifest(row('32.04.08', 'BDO10104'), row('32.04.05', 'BDO10109')), OPTS, quiet, NOW);
    expect(res).toMatchObject({ code: 0, written: 2 });
    const rows = writes.flat() as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.status, r.method])).toEqual([
      ['REVIEW_REQUIRED', 'MANUAL'],
      ['REVIEW_REQUIRED', 'MANUAL'],
    ]);
    expect(rows.every((r) => !('reviewedBy' in r) && !('reviewedAt' in r))).toBe(true);
  });

  it('writes nothing when any row is rejected, unless --allow-partial', async () => {
    const text = manifest(row('32.04.08', 'BDO10104'), row('32.04.05', 'BDO19999'));
    const blocked = importStore();
    expect(await runImport(blocked.store, text, OPTS, quiet, NOW)).toMatchObject({ code: 4, written: 0 });
    expect(blocked.writes).toHaveLength(0);

    const partial = importStore();
    expect(await runImport(partial.store, text, { ...OPTS, allowPartial: true }, quiet, NOW)).toMatchObject({ code: 0, written: 1 });
  });

  it('a rerun of the same manifest writes nothing (idempotent)', async () => {
    const { store, writes } = importStore([
      { districtId: 'dist-32.04.08', jneLocationId: 'loc-BDO10104-DESTINATION', status: 'REVIEW_REQUIRED', isActive: true, jneLocation: { code: 'BDO10104' } },
    ]);
    const tx = jest.spyOn(store, '$transaction');
    const res = await runImport(store, manifest(row('32.04.08', 'BDO10104')), OPTS, quiet, NOW);
    expect(res).toMatchObject({ code: 0, written: 0 });
    expect(res.report).toMatchObject({ accepted: 0, noop: 1, rejected: 0 });
    expect(writes.flat()).toHaveLength(0);
    expect(tx).not.toHaveBeenCalled();
  });

  it('writes a large batch in bounded INSERTs, all inside ONE serializable transaction', async () => {
    const many = Array.from({ length: WRITE_CHUNK + 3 }, (_, i) => district(`33.${String(Math.floor(i / 100)).padStart(2, '0')}.${String(i % 100).padStart(2, '0')}`, `D${i}`));
    const createMany = jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const store: ImportStore = {
      district: { findMany: async () => many },
      jneLocation: { findMany: async () => LOCATIONS },
      jneDistrictMapping: { findMany: async () => [], createMany },
      $transaction: jest.fn(async (fn) => fn(store)),
    };
    const text = manifest(...many.map((d) => row(d.code, 'BDO10104')));
    const res = await runImport(store, text, OPTS, quiet, NOW);
    expect(res.written).toBe(WRITE_CHUNK + 3);
    expect(createMany.mock.calls.map(([a]) => a.data.length)).toEqual([WRITE_CHUNK, 3]);
    expect(store.$transaction).toHaveBeenCalledTimes(1);
    expect((store.$transaction as jest.Mock).mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable', timeout: expect.any(Number) });
  });

  it('a later chunk failing writes nothing at all - there is no partial import to recover from', async () => {
    const many = Array.from({ length: WRITE_CHUNK + 3 }, (_, i) => district(`33.${String(Math.floor(i / 100)).padStart(2, '0')}.${String(i % 100).padStart(2, '0')}`, `D${i}`));
    const committed: unknown[] = [];
    const store: ImportStore = {
      district: { findMany: async () => many },
      jneLocation: { findMany: async () => LOCATIONS },
      jneDistrictMapping: {
        findMany: async () => [],
        createMany: jest.fn().mockResolvedValueOnce({ count: WRITE_CHUNK }).mockRejectedValueOnce(new Error('unique constraint failed')),
      },
      // A transaction that only "commits" when its body resolves, like PostgreSQL.
      $transaction: async (fn) => {
        const out = await fn(store);
        committed.push(out);
        return out;
      },
    };
    await expect(runImport(store, manifest(...many.map((d) => row(d.code, 'BDO10104'))), OPTS, quiet, NOW)).rejects.toThrow(/unique constraint/);
    expect(committed).toHaveLength(0);
  });

  it('aborts with nothing written if any mapping of those districts changed since validation', async () => {
    // Validation saw nothing; by write time a candidate for ANOTHER code has appeared -
    // the unique key would not catch it, the re-check inside the transaction does.
    const createMany = jest.fn();
    let reads = 0;
    const store: ImportStore = {
      district: { findMany: async () => DISTRICTS },
      jneLocation: { findMany: async () => LOCATIONS },
      jneDistrictMapping: {
        findMany: async () =>
          reads++ === 0
            ? []
            : [{ districtId: 'dist-32.04.08', jneLocationId: 'loc-BDO10109-DESTINATION', status: 'REVIEW_REQUIRED', isActive: true, jneLocation: { code: 'BDO10109' } }],
        createMany,
      },
      $transaction: async (fn) => fn(store),
    };
    await expect(runImport(store, manifest(row('32.04.08', 'BDO10104')), OPTS, quiet, NOW)).rejects.toThrow(ManifestChangedError);
    expect(createMany).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ approval

type Found = Awaited<ReturnType<ApprovalStore['jneDistrictMapping']['findMany']>>[number];
const found = (
  id: string,
  districtCode: string,
  jneCode: string,
  status: string,
  over: { isActive?: boolean; kind?: string; locActive?: boolean; districtActive?: boolean; cityActive?: boolean } = {},
): Found => ({
  id,
  status,
  isActive: over.isActive ?? true,
  district: { id: `dist-${districtCode}`, code: districtCode, isActive: over.districtActive ?? true, city: { isActive: over.cityActive ?? true } },
  jneLocation: { code: jneCode, kind: over.kind ?? 'DESTINATION', isActive: over.locActive ?? true },
});

function approvalStore(rows: Found[], otherApproved = 0) {
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const store: ApprovalStore = {
    jneDistrictMapping: {
      findMany: async () => rows,
      count: async () => otherApproved,
      updateMany: async (args) => {
        updates.push(args as never);
        return { count: 1 };
      },
    },
    $transaction: async (fn) => fn(store),
  };
  return { store, updates };
}
const approvals = (...pairs: Array<[string, string]>) => toCsv(['district_code', 'jne_code'], pairs.map(([d, j]) => ({ district_code: d, jne_code: j })));
const AT = () => new Date('2026-10-29T10:00:00.000Z');

describe('approval is separate, explicit and attributed', () => {
  it('requires a named reviewer', async () => {
    const { store, updates } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED')]);
    expect((await runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: ' ', confirm: true }, quiet, AT)).code).toBe(2);
    expect(updates).toHaveLength(0);
  });

  it('promotes exactly the listed pair to MATCHED with reviewer and time, every check repeated in the WHERE', async () => {
    const { store, updates } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED')]);
    const tx = jest.spyOn(store, '$transaction');
    const res = await runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: true }, quiet, AT);
    expect(res).toMatchObject({ code: 0, promoted: 1 });
    expect(updates).toEqual([
      {
        where: {
          id: 'm1',
          status: 'REVIEW_REQUIRED',
          isActive: true,
          jneLocation: { kind: 'DESTINATION', isActive: true },
          district: { isActive: true, city: { isActive: true } },
        },
        data: { status: 'MATCHED', reviewedBy: 'ops-lead', reviewedAt: new Date('2026-10-29T10:00:00.000Z') },
      },
    ]);
    // A batch of thousands must not hit Prisma's 5 s default interactive-transaction timeout.
    expect(tx.mock.calls[0][1]).toMatchObject({ isolationLevel: 'Serializable', timeout: APPROVAL_TIMEOUT_MS });
    expect(APPROVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('aborts if another code was approved for the district after the dry run', async () => {
    const { store, updates } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED')], 1);
    await expect(runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: true }, quiet, AT)).rejects.toThrow(/changed since the dry run/);
    expect(updates).toHaveLength(0);
  });

  it('is a dry run unless --confirm', async () => {
    const { store, updates } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED')]);
    expect((await runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: false }, quiet, AT)).promoted).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it.each([
    ['no pending candidate for the pair', [], 'no REVIEW_REQUIRED candidate'],
    ['approved for another code', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED'), found('m2', '32.04.08', 'BDO10109', 'MATCHED')], 'already approved for BDO10109'],
    ['the candidate is inactive', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED', { isActive: false })], 'inactive'],
    ['the JNE location is inactive', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED', { locActive: false })], 'location is inactive'],
    ['the code is only an ORIGIN', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED', { kind: 'ORIGIN' })], 'no REVIEW_REQUIRED candidate'],
    ['the district is inactive', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED', { districtActive: false })], 'district (or its city) is inactive'],
    ['the district\'s city is inactive', [found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED', { cityActive: false })], 'district (or its city) is inactive'],
  ])('refuses when %s, and writes nothing', async (_what, rows, reason) => {
    const { store, updates } = approvalStore(rows as Found[]);
    const res = await runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: true }, quiet, AT);
    expect(res.code).toBe(4);
    expect(res.decisions[0]).toMatchObject({ outcome: 'REFUSE', reason: expect.stringContaining(reason) });
    expect(updates).toHaveLength(0);
  });

  it('never promotes a second pending code of the same district', () => {
    const d = decideApprovals(
      [{ record: 1, districtCode: '32.04.08', jneCode: 'BDO10104' }],
      [
        { id: 'm1', districtId: 'd', districtCode: '32.04.08', districtActive: true, jneCode: 'BDO10104', kind: 'DESTINATION', locationActive: true, status: 'REVIEW_REQUIRED', isActive: true },
        { id: 'm2', districtId: 'd', districtCode: '32.04.08', districtActive: true, jneCode: 'BDO10109', kind: 'DESTINATION', locationActive: true, status: 'REVIEW_REQUIRED', isActive: true },
      ],
    );
    expect(d).toEqual([{ row: { record: 1, districtCode: '32.04.08', jneCode: 'BDO10104' }, outcome: 'PROMOTE', mappingId: 'm1', districtId: 'd' }]);
  });

  it('refuses an approvals file listing one district with two codes, and duplicates', () => {
    const conflicting = decideApprovals(
      [
        { record: 1, districtCode: '32.04.08', jneCode: 'BDO10104' },
        { record: 2, districtCode: '32.04.08', jneCode: 'BDO10109' },
      ],
      [],
    );
    expect(conflicting.every((d) => d.outcome === 'REFUSE')).toBe(true);
    const dup = decideApprovals(
      [
        { record: 1, districtCode: '32.04.08', jneCode: 'BDO10104' },
        { record: 2, districtCode: '32.04.08', jneCode: 'BDO10104' },
      ],
      [{ id: 'm1', districtId: 'd', districtCode: '32.04.08', districtActive: true, jneCode: 'BDO10104', kind: 'DESTINATION', locationActive: true, status: 'REVIEW_REQUIRED', isActive: true }],
    );
    expect(dup.map((d) => d.outcome)).toEqual(['PROMOTE', 'REFUSE']);
  });

  it('re-approving an approved pair is a no-op', async () => {
    const { store, updates } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'MATCHED')]);
    const res = await runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: true }, quiet, AT);
    expect(res).toMatchObject({ code: 0, promoted: 0 });
    expect(res.decisions[0]).toMatchObject({ outcome: 'NOOP', reason: 'ALREADY_APPROVED' });
    expect(updates).toHaveLength(0);
  });

  it('aborts the whole batch if a row changed since the dry run', async () => {
    const { store } = approvalStore([found('m1', '32.04.08', 'BDO10104', 'REVIEW_REQUIRED')]);
    store.jneDistrictMapping.updateMany = async () => ({ count: 0 });
    await expect(runApprovals(store, approvals(['32.04.08', 'BDO10104']), { reviewer: 'ops-lead', confirm: true }, quiet, AT)).rejects.toThrow(/changed since the dry run/);
  });
});
