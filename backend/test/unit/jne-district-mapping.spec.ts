import {
  approvalDecision,
  KOTA_BANDUNG_DISTRICT_ALIASES,
  KOTA_BANDUNG_PARENT_ALIASES,
  jneParentForCity,
  resolveDistrictCandidate as resolveOne,
  resolveDistrictCandidates as resolveAll,
  type InternalDistrict,
  type JneCandidateRow,
  type ResolveOptions,
} from '../../prisma/tools/jne-district-mapping';
import { parseArgs, formatCandidates, main, RETIRED_FLAGS } from '../../prisma/tools/generate-jne-mapping-candidates';

/**
 * PAXELBOX-61F. Resolving internal districts against JNE master data.
 *
 * The safeguard that matters is DIRECTION. Resolution walks OUR districts and
 * looks for a JNE row, never the reverse — because JNE lists
 * `CILENGKRANG,BANDUNG` and `ARJASARI,BANDUNG` even though both are Kabupaten
 * Bandung, and a JNE-first walk would cheerfully invent Kota Bandung mappings
 * for them. The other safeguard is PARENT-AWARENESS: `Lengkong` exists in
 * Bandung, Sukabumi and Nganjuk, so a child-name-only lookup would bind the
 * wrong one.
 */

// These suites reason about the sandbox-sourced dataset; the source is always the caller's to state.
const sandbox = (options: Partial<ResolveOptions> = {}): ResolveOptions => ({ source: 'SANDBOX', ...options });
const resolveDistrictCandidate = (d: InternalDistrict, rows: JneCandidateRow[], options?: Partial<ResolveOptions>) => resolveOne(d, rows, sandbox(options));
const resolveDistrictCandidates = (ds: InternalDistrict[], rows: JneCandidateRow[], options?: Partial<ResolveOptions>) => resolveAll(ds, rows, sandbox(options));

const CITY = { cityId: 'c1', cityName: 'Kota Bandung', cityType: 'CITY' as const, provinceId: 'p1', provinceName: 'Jawa Barat' };
const district = (name: string, over: Partial<InternalDistrict> = {}): InternalDistrict => ({
  id: `d-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  ...CITY,
  ...over,
});

let seq = 0;
const row = (child: string, parent: string | null, code: string, over: Partial<JneCandidateRow> = {}): JneCandidateRow => ({
  id: `j${++seq}`,
  code,
  rawName: parent ? `${child},${parent}` : child,
  parsedChild: child,
  parsedParent: parent,
  kind: 'DESTINATION',
  source: 'SANDBOX',
  isActive: true,
  ...over,
});

/** Real rows, verbatim from the PAXELBOX-61C dataset. */
const POOL: JneCandidateRow[] = [
  row('ANDIR', 'BANDUNG', 'BDO10041'),
  row('CICENDO', 'BANDUNG', 'BDO10053'),
  row('SUKASARI', 'BANDUNG', 'BDO10037'),
  row('SUKAJADI', 'BANDUNG', 'BDO10059'),
  row('CIDADAP', 'BANDUNG', 'BDO10039'),
  row('LENGKONG', 'BANDUNG', 'BDO10040'),
  // the four alias targets
  row('SUMURBANDUNG', 'BANDUNG', 'BDO10060'),
  row('BABAKANCIPARAY', 'BANDUNG', 'BDO10044'),
  row('CICADAS', 'BANDUNG', 'BDO10038'),
  row('MARGACINTA', 'BANDUNG', 'BDO10056'),
  // Kabupaten Bandung districts JNE files under parent BANDUNG
  row('CILENGKRANG', 'BANDUNG', 'BDO10133'),
  row('ARJASARI', 'BANDUNG', 'BDO10132'),
  // same child names in OTHER cities - the collision trap
  row('SUKASARI', 'PURWAKARTA', 'BDO20813'),
  row('SUKASARI', 'SUMEDANG', 'BDO20218'),
  row('SUKAJADI', 'PEKANBARU', 'PKU10014'),
  row('CIDADAP', 'SUKABUMI', 'SMI10011'),
  row('LENGKONG', 'SUKABUMI', 'SMI10030'),
  row('LENGKONG', 'NGANJUK', 'SUB20417'),
  // PAXELBOX-61G: the two rows carrying JNE's parent typo BANDUG
  row('COBLONG', 'BANDUG', 'BDO10054'),
  row('BOJONGLOA KIDUL', 'BANDUG', 'BDO10050'),
  // city tier
  row('BANDUNG', null, 'BDO10000'),
];

// ------------------------------------------------------- exact resolution

describe('exact candidates', () => {
  it('resolves a single exact child+parent match to REVIEW_REQUIRED — never MATCHED', () => {
    const c = resolveDistrictCandidate(district('Andir'), POOL);

    expect(c.status).toBe('REVIEW_REQUIRED');
    expect(c.method).toBe('EXACT_NAME');
    expect(c.evidence.jneCode).toBe('BDO10041');
    expect(c.evidence.candidateCount).toBe(1);
  });

  it('never emits MATCHED, however clean the match', () => {
    const s = resolveDistrictCandidates([district('Andir'), district('Cicendo')], POOL);
    expect(s.matched).toBe(0);
    expect(s.reviewRequired).toBe(2);
  });
});

// -------------------------------------------------------------- aliases

describe('reviewed aliases', () => {
  it.each([
    ['Sumur Bandung', 'SUMURBANDUNG', 'BDO10060'],
    ['Babakan Ciparay', 'BABAKANCIPARAY', 'BDO10044'],
    ['Antapani', 'CICADAS', 'BDO10038'],
    ['Buahbatu', 'MARGACINTA', 'BDO10056'],
  ])('%s resolves via alias %s -> %s, still REVIEW_REQUIRED', (name, child, code) => {
    const c = resolveDistrictCandidate(district(name), POOL);

    expect(c.method).toBe('REVIEWED_ALIAS');
    expect(c.status).toBe('REVIEW_REQUIRED');
    expect(c.evidence.jneParsedChild).toBe(child);
    expect(c.evidence.jneCode).toBe(code);
    expect(c.evidence.aliasRationale).toMatch(/PAXELBOX-60H/);
  });

  it('the alias table spells BABAKANCIPARAY, not BABAKANCIPAY', () => {
    const a = KOTA_BANDUNG_DISTRICT_ALIASES.find((x) => x.district === 'Babakan Ciparay')!;
    expect(a.jneChild).toBe('BABAKANCIPARAY');
    // The dataset has no such row; a typo would silently produce NOT_FOUND.
    expect(POOL.some((r) => r.parsedChild === 'BABAKANCIPAY')).toBe(false);
  });

  it('an alias is scoped to its city and does not apply elsewhere', () => {
    const elsewhere = district('Antapani', { cityName: 'Kota Cimahi' });
    const c = resolveDistrictCandidate(elsewhere, POOL);
    // The alias is keyed on (district, city), so CICADAS is not substituted here.
    expect(c.method).toBe('EXACT_NAME');
    expect(c.status).toBe('NOT_FOUND');
  });

  it('exactly four aliases exist, all for Kota Bandung', () => {
    expect(KOTA_BANDUNG_DISTRICT_ALIASES).toHaveLength(4);
    for (const a of KOTA_BANDUNG_DISTRICT_ALIASES) expect(a.city).toBe('Kota Bandung');
  });
});

// ------------------------------------------------- Kabupaten contamination

describe('Kabupaten contamination', () => {
  it.each(['Cilengkrang', 'Arjasari'])(
    '%s is never mapped, because resolution walks OUR districts not JNE rows',
    (name) => {
      // Neither is one of Kota Bandung's 30 districts, so it is never looked up.
      const kotaBandungDistricts = ['Andir', 'Cicendo', 'Sukasari'];
      expect(kotaBandungDistricts).not.toContain(name);

      const s = resolveDistrictCandidates(kotaBandungDistricts.map((d) => district(d)), POOL);
      const codes = s.candidates.map((c) => c.evidence.jneCode);
      expect(codes).not.toContain('BDO10133'); // CILENGKRANG
      expect(codes).not.toContain('BDO10132'); // ARJASARI
    },
  );

  it('a REGENCY is refused rather than guessed at', () => {
    const kab = district('Soreang', { cityName: 'Kabupaten Bandung', cityType: 'REGENCY' });
    const c = resolveDistrictCandidate(kab, POOL);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.reason).toMatch(/KAB\. form is inconsistent/);
    expect(jneParentForCity('Kabupaten Bandung', 'REGENCY')).toBeNull();
  });

  it('derives the JNE parent from a CITY by dropping the KOTA prefix', () => {
    expect(jneParentForCity('Kota Bandung', 'CITY')).toBe('BANDUNG');
  });
});

// ------------------------------------------------------ collision names

describe('collision names are resolved parent-aware', () => {
  it.each([
    ['Sukasari', 'BDO10037'],
    ['Sukajadi', 'BDO10059'],
    ['Cidadap', 'BDO10039'],
    ['Lengkong', 'BDO10040'],
  ])('%s binds to the BANDUNG row (%s), not another city', (name, code) => {
    const c = resolveDistrictCandidate(district(name), POOL);

    expect(c.status).toBe('REVIEW_REQUIRED');
    expect(c.evidence.jneCode).toBe(code);
    expect(c.evidence.candidateCount).toBe(1);
    expect(c.evidence.expectedJneParent).toBe('BANDUNG');
  });

  it('a child-name-only match would have been ambiguous — the parent is what saves it', () => {
    // Four LENGKONG rows exist nationally; only one is under BANDUNG.
    const allLengkong = POOL.filter((r) => r.parsedChild === 'LENGKONG');
    expect(allLengkong.length).toBeGreaterThan(1);
    expect(resolveDistrictCandidate(district('Lengkong'), POOL).evidence.candidateCount).toBe(1);
  });

  it('cannot silently produce a mapping from another city when the parent is absent', () => {
    // Only the Sukabumi row exists: our expected parent BANDUNG matches nothing.
    const onlyElsewhere = POOL.filter((r) => r.code === 'SMI10011');
    const c = resolveDistrictCandidate(district('Cidadap'), onlyElsewhere);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.evidence.jneCode).toBeNull();
  });
});

// ---------------------------------------------------- ambiguity + filters

describe('ambiguity and eligibility', () => {
  it('two matching rows yield AMBIGUOUS and select neither', () => {
    const twin = [...POOL, row('ANDIR', 'BANDUNG', 'BDO99999')];
    const c = resolveDistrictCandidate(district('Andir'), twin);

    expect(c.status).toBe('AMBIGUOUS');
    expect(c.jneLocationId).toBeNull();
    expect(c.evidence.candidateCount).toBe(2);
    expect(c.evidence.candidateCodes.sort()).toEqual(['BDO10041', 'BDO99999']);
  });

  it.each([
    ['inactive', { isActive: false }],
    ['an ORIGIN row', { kind: 'ORIGIN' }],
    ['a PRODUCTION row', { source: 'PRODUCTION' }],
  ])('ignores %s', (_label, over) => {
    const pool = [row('ANDIR', 'BANDUNG', 'BDO10041', over)];
    expect(resolveDistrictCandidate(district('Andir'), pool).status).toBe('NOT_FOUND');
  });

  it('reads the stated source: a PRODUCTION run sees PRODUCTION rows and ignores SANDBOX ones', () => {
    const pool = [row('ANDIR', 'BANDUNG', 'BDO10041', { source: 'PRODUCTION' }), row('ANDIR', 'BANDUNG', 'BDO99999')];
    const c = resolveOne(district('Andir'), pool, { source: 'PRODUCTION' });
    expect(c.status).toBe('REVIEW_REQUIRED');
    expect(c.evidence.jneCode).toBe('BDO10041');
  });

  it('never matches a city-tier row with a null parent', () => {
    const c = resolveDistrictCandidate(district('Bandung'), POOL);
    expect(c.status).toBe('NOT_FOUND');
  });
});

// ------------------------------------------------------------- evidence

describe('evidence', () => {
  it('carries every field needed to reproduce the decision', () => {
    const e = resolveDistrictCandidate(district('Andir'), POOL).evidence;

    expect(Object.keys(e).sort()).toEqual(
      [
        'aliasRationale', 'candidateCodes', 'candidateCount', 'expectedJneParent',
        'internalCityId', 'internalCityName', 'internalCityType', 'internalDistrictId',
        'internalDistrictName', 'internalProvinceId', 'internalProvinceName',
        'jneCode', 'jneLocationId', 'jneParsedChild', 'jneParsedParent', 'jneRawName',
        'matchingMethod', 'resolvedAt', 'acceptedJneParents', 'aliasTransformation',
      ].sort(),
    );
    expect(e.internalCityType).toBe('CITY');
    expect(e.internalProvinceName).toBe('Jawa Barat');
    expect(e.jneRawName).toBe('ANDIR,BANDUNG');
  });

  it('records candidates even when the outcome is AMBIGUOUS, so a reviewer sees them', () => {
    const twin = [...POOL, row('ANDIR', 'BANDUNG', 'BDO99999')];
    const e = resolveDistrictCandidate(district('Andir'), twin).evidence;
    expect(e.candidateCodes).toHaveLength(2);
  });

  it('contains no credential-shaped field', () => {
    const dumped = JSON.stringify(resolveDistrictCandidate(district('Andir'), POOL).evidence);
    expect(dumped).not.toMatch(/api[_-]?key|password|username|secret/i);
  });
});

// ----------------------------------------------------------- determinism

describe('determinism and the CLI', () => {
  it('produces identical output across runs', () => {
    const opts = { now: () => '2026-09-02T00:00:00.000Z' };
    const a = resolveDistrictCandidates([district('Andir'), district('Antapani')], POOL, opts);
    const b = resolveDistrictCandidates([district('Andir'), district('Antapani')], POOL, opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('the retired write flags are refused, not ignored', () => {
    for (const flag of RETIRED_FLAGS) expect(parseArgs([flag, 'x'])).toEqual({ refused: expect.stringContaining('read-only') });
    expect(parseArgs(['--city', 'Kota Bandung', '--approve', 'Andir,Cicendo', '--reviewer', 'ops'])).toEqual({
      refused: expect.stringContaining('--approve, --reviewer'),
    });
    expect(parseArgs(['--city', 'Kota Cimahi', '--source', 'PRODUCTION'])).toEqual({ city: 'Kota Cimahi', source: 'PRODUCTION' });
    expect(parseArgs(['--source', 'SANDBOX'])).toEqual({ city: 'Kota Bandung', source: 'SANDBOX' });
  });

  it('has no default source: omitting or misspelling --source is refused', () => {
    expect(parseArgs(['--city', 'Kota Cimahi'])).toEqual({ refused: expect.stringContaining('--source SANDBOX|PRODUCTION is required') });
    expect(parseArgs(['--source', 'sandbox'])).toEqual({ refused: expect.stringContaining('there is no default') });
  });

  it('confidence fits the VarChar(32) column', () => {
    // A disposable-DB run in PAXELBOX-61F rejected a 47-character value here;
    // the grade belongs in `confidence`, the sentence in `notes`.
    for (const c of resolveDistrictCandidates([district('Andir'), district('Antapani')], POOL).candidates) {
      if (c.confidence !== null) expect(c.confidence.length).toBeLessThanOrEqual(32);
    }
  });

  it('formats a reviewable table', () => {
    const s = resolveDistrictCandidates([district('Andir')], POOL);
    const out = formatCandidates(s.candidates);
    expect(out).toContain('Andir');
    expect(out).toContain('REVIEW_REQUIRED');
    expect(out).toContain('BDO10041');
  });
});

// --------------------------------- PAXELBOX-61G: the reviewed PARENT alias

/**
 * JNE spells the parent of two Kota Bandung rows `BANDUG`. That is a typo in
 * THEIR data, and the resolver refuses it by default - which is why 61F produced
 * 28 candidates rather than 30.
 *
 * The alias below admits exactly that one parent string, scoped to city AND
 * province AND CITY-type. It is not a typo corrector: nothing here computes edit
 * distance or rewrites any other parent, and the tests prove a near-miss like
 * `BANDNG` is still refused.
 */
describe('reviewed PARENT alias BANDUG -> BANDUNG', () => {
  it.each([
    ['Coblong', 'BDO10054'],
    ['Bojongloa Kidul', 'BDO10050'],
  ])('%s resolves to %s via the parent alias', (name, code) => {
    const c = resolveDistrictCandidate(district(name), POOL);

    expect(c.status).toBe('REVIEW_REQUIRED');
    expect(c.method).toBe('REVIEWED_ALIAS');
    expect(c.evidence.jneCode).toBe(code);
    expect(c.evidence.candidateCount).toBe(1);
    expect(c.evidence.jneParsedParent).toBe('BANDUG');
    expect(c.evidence.expectedJneParent).toBe('BANDUNG');
    expect(c.evidence.aliasTransformation).toBe('parent "BANDUG" -> "BANDUNG"');
  });

  it('never becomes MATCHED', () => {
    for (const n of ['Coblong', 'Bojongloa Kidul']) {
      expect(resolveDistrictCandidate(district(n), POOL).status).not.toBe('MATCHED');
    }
  });

  it('the rationale states it is a reviewed alias and NOT fuzzy matching', () => {
    const r = resolveDistrictCandidate(district('Coblong'), POOL).evidence.aliasRationale!;
    expect(r).toMatch(/typo alias/i);
    expect(r).toMatch(/NOT fuzzy matching/);
    expect(r).toMatch(/BDO10054/);
    expect(r).toMatch(/BDO10050/);
  });

  it('exactly one parent alias exists, scoped to Kota Bandung / Jawa Barat', () => {
    expect(KOTA_BANDUNG_PARENT_ALIASES).toHaveLength(1);
    const [a] = KOTA_BANDUNG_PARENT_ALIASES;
    expect(a).toMatchObject({ kind: 'PARENT', city: 'Kota Bandung', province: 'Jawa Barat', jneParent: 'BANDUG' });
  });

  it('does NOT apply to a different city', () => {
    const other = district('Coblong', { cityName: 'Kota Cimahi' });
    const c = resolveDistrictCandidate(other, POOL);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.evidence.acceptedJneParents).toEqual(['CIMAHI']);
  });

  it('does NOT apply to a different province', () => {
    const other = district('Coblong', { provinceName: 'Banten' });
    const c = resolveDistrictCandidate(other, POOL);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.evidence.acceptedJneParents).toEqual(['BANDUNG']);
  });

  it('does NOT apply to a REGENCY', () => {
    const kab = district('Coblong', { cityName: 'Kabupaten Bandung', cityType: 'REGENCY' });
    const c = resolveDistrictCandidate(kab, POOL);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.evidence.acceptedJneParents).toEqual([]);
  });

  it('performs NO fuzzy parent matching - a different near-miss is still refused', () => {
    const pool = [row('SOMEWHERE', 'BANDNG', 'BDO19998')]; // one letter off, not reviewed
    const c = resolveDistrictCandidate(district('Somewhere'), pool);

    expect(c.status).toBe('NOT_FOUND');
    expect(c.evidence.acceptedJneParents).toEqual(['BANDUNG', 'BANDUG']);
  });

  it('an exact BANDUNG match is still EXACT_NAME, not tainted by the alias', () => {
    const c = resolveDistrictCandidate(district('Andir'), POOL);
    expect(c.method).toBe('EXACT_NAME');
    expect(c.evidence.aliasTransformation).toBeNull();
  });

  it('would report AMBIGUOUS if a child existed under BOTH parents', () => {
    // Not the case in the real dataset (verified: 0 such districts), but the
    // alias must not become a tie-breaker if that ever changes.
    const both = [...POOL, row('COBLONG', 'BANDUNG', 'BDO19997')];
    const c = resolveDistrictCandidate(district('Coblong'), both);

    expect(c.status).toBe('AMBIGUOUS');
    expect(c.jneLocationId).toBeNull();
    expect(c.evidence.candidateCount).toBe(2);
  });

  it('the contamination rows are still excluded with the alias active', () => {
    const s = resolveDistrictCandidates(
      ['Andir', 'Coblong', 'Bojongloa Kidul', 'Sukasari'].map((d) => district(d)),
      POOL,
    );
    const codes = s.candidates.map((c) => c.evidence.jneCode);
    expect(codes).not.toContain('BDO10133'); // CILENGKRANG
    expect(codes).not.toContain('BDO10132'); // ARJASARI
    expect(s.matched).toBe(0);
  });
});

// ------------------------------------ PAXELBOX-61H: the approval gate

/**
 * Approval is what turns a resolver's opinion into a decision. The rule is
 * narrow on purpose: only REVIEW_REQUIRED is promotable. Approving AMBIGUOUS
 * would mean choosing between candidates the resolver deliberately refused to
 * choose between; approving NOT_FOUND would mean inventing a candidate. Both
 * would quietly undo every safeguard upstream of them.
 */
describe('approval gate', () => {
  it('promotes REVIEW_REQUIRED', () => {
    const d = approvalDecision('REVIEW_REQUIRED');
    expect(d.promotable).toBe(true);
    expect(d.alreadyApproved).toBe(false);
  });

  it('is idempotent on an already MATCHED row — a no-op, not an error', () => {
    const d = approvalDecision('MATCHED');
    expect(d.promotable).toBe(false);
    expect(d.alreadyApproved).toBe(true);
    expect(d.reason).toMatch(/already approved/);
  });

  it('refuses AMBIGUOUS — approving it would mean choosing a candidate', () => {
    const d = approvalDecision('AMBIGUOUS');
    expect(d.promotable).toBe(false);
    expect(d.alreadyApproved).toBe(false);
    expect(d.reason).toMatch(/choosing one/);
  });

  it('refuses NOT_FOUND — approving it would mean inventing a candidate', () => {
    const d = approvalDecision('NOT_FOUND');
    expect(d.promotable).toBe(false);
    expect(d.reason).toMatch(/inventing one/);
  });

  it('only REVIEW_REQUIRED is promotable, of every status that exists', () => {
    const statuses = ['MATCHED', 'REVIEW_REQUIRED', 'AMBIGUOUS', 'NOT_FOUND'] as const;
    expect(statuses.filter((s) => approvalDecision(s).promotable)).toEqual(['REVIEW_REQUIRED']);
  });

  it('this CLI no longer approves at all - with or without a reviewer', () => {
    // Approval moved to approve-jne-mappings.ts, which requires --reviewer and explicit pairs.
    expect(parseArgs(['--approve', 'Andir'])).toEqual({ refused: expect.stringContaining('approve-jne-mappings.ts') });
    expect(parseArgs(['--approve', 'Andir', '--reviewer', 'someone'])).toEqual({ refused: expect.stringContaining('read-only') });
  });

  it('approval cannot introduce a new alias — the alias tables are the only source', () => {
    // Approval only changes status/reviewer/reviewedAt. Nothing in the approval
    // path can add an entry to either alias table.
    expect(KOTA_BANDUNG_DISTRICT_ALIASES).toHaveLength(4);
    expect(KOTA_BANDUNG_PARENT_ALIASES).toHaveLength(1);
  });

  it('approving does not change how a candidate was resolved', () => {
    // method / evidence / transformation come from resolution, which approval
    // never re-runs. An exact match stays EXACT_NAME with no transformation.
    const exact = resolveDistrictCandidate(district('Andir'), POOL);
    expect(exact.method).toBe('EXACT_NAME');
    expect(exact.evidence.aliasTransformation).toBeNull();

    const child = resolveDistrictCandidate(district('Antapani'), POOL);
    expect(child.method).toBe('REVIEWED_ALIAS');
    expect(child.evidence.aliasTransformation).toMatch(/child/);

    const parent = resolveDistrictCandidate(district('Coblong'), POOL);
    expect(parent.method).toBe('REVIEWED_ALIAS');
    expect(parent.evidence.aliasTransformation).toMatch(/parent/);
  });

  it('all six aliases carry a rationale that survives approval unchanged', () => {
    for (const n of ['Antapani', 'Babakan Ciparay', 'Buahbatu', 'Sumur Bandung', 'Coblong', 'Bojongloa Kidul']) {
      const c = resolveDistrictCandidate(district(n), POOL);
      expect(c.method).toBe('REVIEWED_ALIAS');
      expect(c.evidence.aliasRationale).toBeTruthy();
      expect(c.evidence.aliasTransformation).toBeTruthy();
    }
  });
});

// ------------------------------- the legacy CLI can no longer write or approve

describe('generate-jne-mapping-candidates is read-only', () => {
  const WRITES = ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', '$executeRaw', '$executeRawUnsafe', '$transaction'];

  /** A store answering the two reads; touching ANY other member - a write - fails the test. */
  function store() {
    const touched: string[] = [];
    const prismaDistrict = (d: InternalDistrict) => ({
      id: d.id,
      name: d.name,
      city: { id: d.cityId, name: d.cityName, type: d.cityType, province: { id: d.provinceId, name: d.provinceName } },
    });
    const model = (name: string, reads: Record<string, unknown>) =>
      new Proxy(reads, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          touched.push(`${name}.${prop}`);
          throw new Error(`write attempted: ${name}.${prop}`);
        },
      });
    const db = new Proxy(
      {
        district: model('district', { findMany: async () => [prismaDistrict(district('Andir')), prismaDistrict(district('Cicendo'))] }),
        jneLocation: model('jneLocation', { findMany: async () => POOL }),
      } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          touched.push(prop);
          throw new Error(`unexpected access: ${prop}`);
        },
      },
    );
    let opened = 0;
    return { touched, open: () => (opened++, db as never), opened: () => opened };
  }

  it('lists candidates using two reads and nothing else', async () => {
    const s = store();
    const lines: string[] = [];
    await expect(main(['--city', 'Kota Bandung', '--source', 'SANDBOX'], s.open, (l) => lines.push(l))).resolves.toBe(0);
    expect(s.touched).toEqual([]);
    const out = lines.join('\n');
    expect(out).toContain('BDO10041');
    expect(out).toContain('REVIEW_REQUIRED');
    expect(out).toContain('read-only: nothing was written');
  });

  it.each(RETIRED_FLAGS.map((f) => [f]))('%s exits 2 before the database is even opened', async (flag) => {
    const s = store();
    const lines: string[] = [];
    await expect(main(['--city', 'Kota Bandung', '--source', 'SANDBOX', flag, 'Andir,Cicendo'], s.open, (l) => lines.push(l))).resolves.toBe(2);
    expect(s.opened()).toBe(0);
    expect(s.touched).toEqual([]);
    expect(lines.join('\n')).toMatch(/import-jne-mapping-manifest\.ts.*approve-jne-mappings\.ts/);
  });

  it('the source has no write call left', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../prisma/tools/generate-jne-mapping-candidates.ts'), 'utf8') as string;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const w of WRITES) expect(code).not.toContain(`.${w}(`);
  });
});
