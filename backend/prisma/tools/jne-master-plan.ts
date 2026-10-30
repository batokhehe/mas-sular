/**
 * What importing a JNE master snapshot WOULD do, computed against everything the
 * database currently holds. No I/O: `import-jne-master.ts` supplies the snapshot and
 * the live rows, and writes only what a blocker-free plan lists.
 *
 * ---------------------------------------------------------------------------
 * RULES THE PLAN ENFORCES
 *
 * - The natural key is (code, kind). A code can exist once per kind, so an import
 *   updates a row in place, keeping the `id` every mapping references. The plan never
 *   proposes a mapping change, and never picks a replacement code by name.
 * - A code absent from the snapshot is REPORTED, never deactivated. Deactivation is a
 *   separate action, on an explicit list.
 * - A rename under an active MATCHED mapping blocks the import until a reviewer lists
 *   that exact code, old name and new name.
 * - `--source` alone proves nothing. A PRODUCTION import needs the capture's metadata
 *   and a target environment that agree with it, and a SANDBOX import can never touch
 *   a master that already holds PRODUCTION rows.
 * - HTTP 200 proves nothing about completeness. JNE returns no total count and no
 *   paging fields, so the reviewed record count, unique-code count and checksum are
 *   required to write.
 * - An import writes one kind. The other kind is a protected set: its rows are never
 *   a write target, its fingerprint is part of the plan, and the import rolls back if
 *   that fingerprint moves. A DESTINATION refresh therefore leaves the ORIGIN master,
 *   whatever its source, exactly as it was. It only needs the configured origin code
 *   to be active there, the same condition the backend checks at boot.
 */
import { createHash } from 'node:crypto';

import { isJneSandboxUrl } from '../../src/modules/shipping/shipping.config';
import type { JneDataSource, JneLocationKind, JneLocationSeed, JneMasterInspection } from './jne-master';

/** The path a capture of each master must have come from. A check on metadata: nothing here calls JNE. */
export const JNE_MASTER_PATHS: Record<JneLocationKind, string> = {
  DESTINATION: '/insert/getdestination',
  ORIGIN: '/insert/getorigin',
};

export interface ExistingLocation {
  id: string;
  code: string;
  kind: JneLocationKind;
  source: JneDataSource;
  rawName: string;
  isActive: boolean;
  sourceFetchedAt: Date | string;
  normalizedName: string;
  parsedChild: string;
  parsedParent: string | null;
  partCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ExistingMapping {
  id: string;
  status: string;
  isActive: boolean;
  districtCode: string;
  districtName: string;
  jneCode: string;
  kind: JneLocationKind;
}

/** A reviewer's approval of one exact rename. The names are compared byte for byte. */
export interface ReviewedRename {
  code: string;
  from: string;
  to: string;
}

/** The non-secret record of how a snapshot was captured (fetch-metadata.json). */
export interface SnapshotProvenance {
  environment: string;
  method: string;
  url: string;
  httpStatus: number;
  bodySha256: string;
  requestStartedUtc: string;
}

/** Non-secret settings of the environment an import runs in. */
export interface TargetEnvironment {
  jneEnvironment?: string;
  jneBaseUrl?: string;
  jneOriginCode?: string;
}

export interface SnapshotExpectations {
  records?: number;
  uniqueCodes?: number;
  sha256?: string;
  planSha256?: string;
}

export type BlockerCode =
  | 'INVALID_RECORDS'
  | 'DUPLICATE_CODES'
  | 'EXPECTED_VALUE_REQUIRED'
  | 'RECORD_COUNT_MISMATCH'
  | 'UNIQUE_CODE_COUNT_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'PLAN_MISMATCH'
  | 'FETCH_TIME_UNKNOWN'
  | 'STALE_SNAPSHOT'
  | 'PROVENANCE_MISSING'
  | 'PROVENANCE_INVALID'
  | 'TARGET_ENVIRONMENT_MISMATCH'
  | 'SANDBOX_INTO_PRODUCTION_MASTER'
  | 'RENAME_NEEDS_REVIEW'
  | 'REVIEWED_RENAME_NOT_PENDING'
  | 'ORIGIN_CODE_UNKNOWN'
  | 'ORIGIN_CODE_NOT_IN_SNAPSHOT'
  | 'ORIGIN_CODE_NOT_ACTIVE';

export interface Blocker {
  code: BlockerCode;
  detail: string;
}

export type LocationChange = 'rawName' | 'source' | 'sourceFetchedAt' | 'isActive';

export interface LocationUpdate {
  id: string;
  code: string;
  seed: JneLocationSeed;
  changes: LocationChange[];
  fromRawName: string;
  fromSource: JneDataSource;
  wasActive: boolean;
}

export interface MissingLocation {
  id: string;
  code: string;
  source: JneDataSource;
  rawName: string;
  isActive: boolean;
  activeMatched: number;
  activeReview: number;
}

export type MappingState = 'UNCHANGED' | 'RELABELLED' | 'RENAMED' | 'MISSING';

export interface MappingImpact {
  mappingId: string;
  status: string;
  isActive: boolean;
  districtCode: string;
  districtName: string;
  jneCode: string;
  state: MappingState;
  fromRawName: string | null;
  toRawName: string | null;
}

export interface MasterImportPlan {
  kind: JneLocationKind;
  source: JneDataSource;
  snapshotSha256: string;
  sourceFetchedAt: string | null;
  records: number;
  uniqueCodes: number;
  accepted: number;
  duplicates: JneMasterInspection['duplicates'];
  invalid: JneMasterInspection['invalid'];
  testCodes: string[];
  /** Rows of this kind in the database, per source, before the import. */
  existingBySource: Record<string, number>;
  /** Incoming codes that also exist under the other kind: separate rows, reported only. */
  alsoInOtherKind: number;
  /** The kind this import may not touch, its rows as read, and their fingerprint. */
  protectedKind: JneLocationKind;
  protectedRows: ExistingLocation[];
  protectedFingerprint: string;
  unchanged: number;
  created: JneLocationSeed[];
  updated: LocationUpdate[];
  missing: MissingLocation[];
  mappingImpact: MappingImpact[];
  warnings: string[];
  blockers: Blocker[];
  /**
   * Identity of what would be written, from which snapshot, to which kind, in which
   * environment. Excludes blockers and reviews, so a dry run's value stays valid once
   * they are dealt with.
   */
  planSha256: string;
}

export interface PlanInput {
  kind: JneLocationKind;
  source: JneDataSource;
  sha256: string;
  sourceFetchedAt: string | null;
  inspection: JneMasterInspection;
  seeds: JneLocationSeed[];
  existing: ExistingLocation[];
  mappings: ExistingMapping[];
  reviewedRenames: ReviewedRename[];
  provenance: SnapshotProvenance | null;
  target: TargetEnvironment;
  expected: SnapshotExpectations;
  /** A write requires every expected value; a dry run checks only those given. */
  requireExpectations: boolean;
}

const time = (v: Date | string) => new Date(v).getTime();

function provenanceProblems(input: PlanInput): string[] {
  const { provenance: p, source, kind, sha256, target } = input;
  if (!p) return [];
  const problems: string[] = [];
  if (p.environment !== source) problems.push(`metadata says ${p.environment}, the import says ${source}`);
  if (p.httpStatus !== 200) problems.push(`metadata records HTTP ${p.httpStatus}`);
  if (p.bodySha256 !== sha256) problems.push('metadata checksum does not match the snapshot file');
  if (p.method !== 'POST') problems.push(`metadata records method ${p.method}`);

  let url: URL | null = null;
  try {
    url = new URL(p.url);
  } catch {
    problems.push('metadata URL does not parse');
  }
  if (url) {
    if (url.pathname !== JNE_MASTER_PATHS[kind]) problems.push(`metadata path ${url.pathname} is not the ${kind} master`);
    if (source === 'PRODUCTION') {
      if (url.protocol !== 'https:') problems.push('metadata URL is not https');
      if (isJneSandboxUrl(p.url)) problems.push('metadata URL is the known sandbox endpoint');
      // The positive check: the capture must name the endpoint this environment uses.
      // Comparing against a constant would be the production constant shipping.config
      // deliberately does not have.
      let base: string | null = null;
      try {
        base = target.jneBaseUrl ? new URL(target.jneBaseUrl).origin : null;
      } catch {
        base = null;
      }
      if (base === null) problems.push('JNE_BASE_URL is not set in this environment');
      else if (url.origin !== base) problems.push('metadata endpoint differs from JNE_BASE_URL in this environment');
    }
  }
  return problems;
}

/** Every column of every row, so any change to any of them moves the fingerprint. */
export function locationFingerprint(rows: ExistingLocation[]): string {
  const iso = (v: Date | string) => new Date(v).toISOString();
  const identity = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => [r.id, r.code, r.kind, r.source, r.rawName, r.normalizedName, r.parsedChild, r.parsedParent, r.partCount, r.isActive, iso(r.sourceFetchedAt), iso(r.createdAt), iso(r.updatedAt)]);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function planHash(
  plan: Pick<MasterImportPlan, 'kind' | 'source' | 'snapshotSha256' | 'sourceFetchedAt' | 'created' | 'updated' | 'missing' | 'mappingImpact' | 'protectedFingerprint'>,
  target: TargetEnvironment,
): string {
  const identity = {
    // Staging and production hold rows with the same ids, so without the target a plan
    // reviewed on one would be accepted on the other. None of these values is a secret.
    target: [target.jneEnvironment ?? 'sandbox', target.jneBaseUrl ?? null, target.jneOriginCode?.trim() ?? null],
    kind: plan.kind,
    source: plan.source,
    snapshot: plan.snapshotSha256,
    fetchedAt: plan.sourceFetchedAt,
    created: plan.created.map((s) => [s.code, s.rawName]),
    updated: plan.updated.map((u) => [u.id, u.code, u.changes, u.fromRawName, u.seed.rawName, u.fromSource, u.wasActive]),
    missing: plan.missing.map((m) => [m.id, m.code, m.isActive, m.activeMatched, m.activeReview]),
    mappings: plan.mappingImpact.map((m) => [m.mappingId, m.status, m.isActive, m.jneCode, m.state]),
    protectedFingerprint: plan.protectedFingerprint,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export function planMasterImport(input: PlanInput): MasterImportPlan {
  const { kind, source, inspection, seeds, reviewedRenames, target, expected } = input;
  const blockers: Blocker[] = [];
  const warnings: string[] = [];
  const block = (code: BlockerCode, detail: string) => blockers.push({ code, detail });

  const sameKind = input.existing.filter((e) => e.kind === kind);
  const protectedRows = input.existing.filter((e) => e.kind !== kind);
  const otherKind = new Set(protectedRows.map((e) => e.code));
  const existingByCode = new Map(sameKind.map((e) => [e.code, e]));
  const incoming = new Set(seeds.map((s) => s.code));
  // Listed in the snapshot but refused as a row: not "missing", and not a code to deactivate.
  const excluded = new Set([...inspection.testCodes, ...inspection.duplicates.map((d) => d.code)]);

  const mappingsOf = new Map<string, ExistingMapping[]>();
  for (const m of input.mappings.filter((x) => x.kind === kind)) {
    mappingsOf.set(m.jneCode, [...(mappingsOf.get(m.jneCode) ?? []), m]);
  }

  const created: JneLocationSeed[] = [];
  const updated: LocationUpdate[] = [];
  let unchanged = 0;

  for (const seed of seeds) {
    const prev = existingByCode.get(seed.code);
    if (!prev) {
      created.push(seed);
      continue;
    }
    const changes: LocationChange[] = [];
    if (prev.rawName !== seed.rawName) changes.push('rawName');
    if (prev.source !== source) changes.push('source');
    if (input.sourceFetchedAt !== null && time(prev.sourceFetchedAt) !== time(input.sourceFetchedAt)) changes.push('sourceFetchedAt');
    if (prev.isActive !== seed.isActive) changes.push('isActive');
    if (changes.length === 0) unchanged += 1;
    else updated.push({ id: prev.id, code: seed.code, seed, changes, fromRawName: prev.rawName, fromSource: prev.source, wasActive: prev.isActive });
  }

  const missing: MissingLocation[] = sameKind
    .filter((e) => !incoming.has(e.code) && !excluded.has(e.code))
    .map((e) => {
      const active = (mappingsOf.get(e.code) ?? []).filter((m) => m.isActive);
      return {
        id: e.id,
        code: e.code,
        source: e.source,
        rawName: e.rawName,
        isActive: e.isActive,
        activeMatched: active.filter((m) => m.status === 'MATCHED').length,
        activeReview: active.filter((m) => m.status === 'REVIEW_REQUIRED').length,
      };
    });

  // ---- existing mappings: read, reported, never written
  const updateByCode = new Map(updated.map((u) => [u.code, u]));
  const missingCodes = new Set(missing.map((m) => m.code));
  const mappingImpact: MappingImpact[] = [...mappingsOf.values()].flat().map((m) => {
    const u = updateByCode.get(m.jneCode);
    const state: MappingState =
      missingCodes.has(m.jneCode) ? 'MISSING'
      : u?.changes.includes('rawName') ? 'RENAMED'
      : u ? 'RELABELLED'
      : 'UNCHANGED';
    return {
      mappingId: m.id,
      status: m.status,
      isActive: m.isActive,
      districtCode: m.districtCode,
      districtName: m.districtName,
      jneCode: m.jneCode,
      state,
      fromRawName: state === 'RENAMED' ? (u as LocationUpdate).fromRawName : null,
      toRawName: state === 'RENAMED' ? (u as LocationUpdate).seed.rawName : null,
    };
  });

  const reviewed = new Map(reviewedRenames.map((r) => [r.code, r]));
  const pendingRenames = updated.filter((u) => u.changes.includes('rawName'));
  for (const u of pendingRenames) {
    const active = (mappingsOf.get(u.code) ?? []).filter((m) => m.isActive);
    const r = reviewed.get(u.code);
    const approved = r !== undefined && r.from === u.fromRawName && r.to === u.seed.rawName;
    if (active.some((m) => m.status === 'MATCHED') && !approved) {
      block('RENAME_NEEDS_REVIEW', `${u.code}: "${u.fromRawName}" -> "${u.seed.rawName}" changes a location with an active MATCHED mapping`);
    }
    if (active.some((m) => m.status === 'REVIEW_REQUIRED')) {
      warnings.push(`${u.code} renamed under a REVIEW_REQUIRED mapping: the reviewer should see "${u.seed.rawName}"`);
    }
  }
  // Only when there is something to write: repeating a finished import with its own
  // review file must stay a no-op, and by then none of those renames is pending.
  for (const r of created.length + updated.length > 0 ? reviewedRenames : []) {
    const u = pendingRenames.find((p) => p.code === r.code);
    if (!u || u.fromRawName !== r.from || u.seed.rawName !== r.to) {
      block('REVIEWED_RENAME_NOT_PENDING', `${r.code}: the reviewed rename does not match the plan, so the review was of something else`);
    }
  }
  for (const m of missing) {
    if (m.activeMatched > 0) warnings.push(`${m.code} has ${m.activeMatched} active MATCHED mapping(s) but is absent from this snapshot`);
  }

  // ---- snapshot contents and completeness
  if (inspection.invalid.length > 0) block('INVALID_RECORDS', `${inspection.invalid.length} invalid record(s)`);
  if (inspection.duplicates.length > 0) block('DUPLICATE_CODES', `${inspection.duplicates.length} code(s) appear more than once`);
  if (inspection.testCodes.length > 0) warnings.push(`known test code(s) not imported: ${inspection.testCodes.join(', ')}`);

  if (input.requireExpectations) {
    const absent = [
      expected.records === undefined && '--expect-records',
      expected.uniqueCodes === undefined && '--expect-unique-codes',
      !expected.sha256 && '--expect-sha256',
    ].filter(Boolean);
    if (absent.length > 0) block('EXPECTED_VALUE_REQUIRED', `JNE publishes no total count, so a write needs ${absent.join(', ')}`);
  }
  if (expected.records !== undefined && expected.records !== inspection.records) {
    block('RECORD_COUNT_MISMATCH', `snapshot has ${inspection.records} record(s), ${expected.records} expected`);
  }
  if (expected.uniqueCodes !== undefined && expected.uniqueCodes !== inspection.uniqueCodes) {
    block('UNIQUE_CODE_COUNT_MISMATCH', `snapshot has ${inspection.uniqueCodes} unique code(s), ${expected.uniqueCodes} expected`);
  }
  if (expected.sha256 && expected.sha256 !== input.sha256) {
    block('CHECKSUM_MISMATCH', `snapshot sha256 is ${input.sha256}, ${expected.sha256} expected`);
  }

  // ---- provenance: the --source flag is a claim, this is what backs it
  if (input.sourceFetchedAt === null) block('FETCH_TIME_UNKNOWN', 'the snapshot has no capture time; refusing to record the import time as the fetch time');
  if (source === 'PRODUCTION' && !input.provenance) block('PROVENANCE_MISSING', '--metadata is required: --source PRODUCTION is not evidence on its own');
  for (const p of provenanceProblems(input)) block('PROVENANCE_INVALID', p);

  const environment = target.jneEnvironment ?? 'sandbox';
  if ((source === 'PRODUCTION') !== (environment === 'production')) {
    block('TARGET_ENVIRONMENT_MISMATCH', `a ${source} master does not belong in a JNE_ENVIRONMENT=${environment} database`);
  }

  const productionRows = sameKind.filter((e) => e.source === 'PRODUCTION').length;
  if (source === 'SANDBOX' && productionRows > 0) {
    block('SANDBOX_INTO_PRODUCTION_MASTER', `${productionRows} ${kind} row(s) are already PRODUCTION; a sandbox snapshot may not touch that master`);
  }
  if (input.sourceFetchedAt !== null) {
    const newer = sameKind.filter((e) => e.source === source && time(e.sourceFetchedAt) > time(input.sourceFetchedAt as string)).length;
    if (newer > 0) block('STALE_SNAPSHOT', `${newer} ${source} row(s) came from a newer snapshot than this one`);
  }

  // ---- origin: boot refuses a missing or inactive JNE_ORIGIN_CODE (jne-origin-boot.validator.ts)
  const originCode = target.jneOriginCode?.trim();
  if (source === 'PRODUCTION' && !originCode) block('ORIGIN_CODE_UNKNOWN', 'JNE_ORIGIN_CODE is not set in this environment');
  if (originCode && kind === 'ORIGIN' && !incoming.has(originCode)) {
    block('ORIGIN_CODE_NOT_IN_SNAPSHOT', `JNE_ORIGIN_CODE ${originCode} is not in this origin snapshot`);
  }
  if (originCode && kind === 'DESTINATION' && source === 'PRODUCTION') {
    // Availability, not provenance: the ORIGIN master is deliberately kept as it is.
    const origin = protectedRows.find((e) => e.code === originCode);
    if (!origin?.isActive) {
      block('ORIGIN_CODE_NOT_ACTIVE', `JNE_ORIGIN_CODE ${originCode} is ${origin ? 'inactive' : 'absent'} in the ORIGIN master; the backend would refuse to start`);
    }
  }

  const planFields = {
    kind,
    source,
    snapshotSha256: input.sha256,
    sourceFetchedAt: input.sourceFetchedAt,
    created,
    updated,
    missing,
    mappingImpact,
    protectedFingerprint: locationFingerprint(protectedRows),
  };
  const planSha256 = planHash(planFields, target);
  const writes = created.length + updated.length;
  if (input.requireExpectations && writes > 0) {
    if (!expected.planSha256) block('EXPECTED_VALUE_REQUIRED', `a write needs --expect-plan with the dry run's plan hash (${planSha256})`);
    else if (expected.planSha256 !== planSha256) block('PLAN_MISMATCH', `this run's plan is ${planSha256}, the reviewed plan was ${expected.planSha256}`);
  }

  return {
    ...planFields,
    records: inspection.records,
    uniqueCodes: inspection.uniqueCodes,
    accepted: seeds.length,
    duplicates: inspection.duplicates,
    invalid: inspection.invalid,
    testCodes: inspection.testCodes,
    existingBySource: sameKind.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.source]: (acc[e.source] ?? 0) + 1 }), {}),
    alsoInOtherKind: seeds.filter((s) => otherKind.has(s.code)).length,
    protectedKind: kind === 'ORIGIN' ? 'DESTINATION' : 'ORIGIN',
    protectedRows,
    unchanged,
    warnings,
    blockers,
    planSha256,
  };
}

export function formatPlan(plan: MasterImportPlan): string {
  const count = (state: MappingState, status: string) => plan.mappingImpact.filter((m) => m.state === state && m.status === status && m.isActive).length;
  const renamed = plan.updated.filter((u) => u.changes.includes('rawName')).length;
  const relabelled = plan.updated.filter((u) => u.changes.includes('source')).length;
  const reactivated = plan.updated.filter((u) => u.changes.includes('isActive')).length;
  const activeMissing = plan.missing.filter((m) => m.isActive).length;
  return [
    `  snapshot            : ${plan.kind} ${plan.source} sha256 ${plan.snapshotSha256}`,
    `  fetched at          : ${plan.sourceFetchedAt ?? 'unknown'}`,
    `  records             : ${plan.records}`,
    `  unique codes        : ${plan.uniqueCodes}`,
    `  duplicate codes     : ${plan.duplicates.length}`,
    `  invalid records     : ${plan.invalid.length}`,
    `  test codes excluded : ${plan.testCodes.length ? plan.testCodes.join(', ') : 0}`,
    `  live rows, by source: ${Object.entries(plan.existingBySource).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
    `  also in other kind  : ${plan.alsoInOtherKind}`,
    `  protected, untouched: ${plan.protectedRows.length} ${plan.protectedKind} row(s), fingerprint ${plan.protectedFingerprint}`,
    `  unchanged           : ${plan.unchanged}`,
    `  new                 : ${plan.created.length}`,
    `  changed             : ${plan.updated.length} (rawName ${renamed}, source ${relabelled}, reactivated ${reactivated})`,
    `  missing             : ${plan.missing.length} (${activeMissing} active; reported, not deactivated)`,
    `  MATCHED mappings    : unchanged ${count('UNCHANGED', 'MATCHED')}, relabelled ${count('RELABELLED', 'MATCHED')}, renamed ${count('RENAMED', 'MATCHED')}, missing ${count('MISSING', 'MATCHED')}`,
    `  REVIEW_REQUIRED     : unchanged ${count('UNCHANGED', 'REVIEW_REQUIRED')}, relabelled ${count('RELABELLED', 'REVIEW_REQUIRED')}, renamed ${count('RENAMED', 'REVIEW_REQUIRED')}, missing ${count('MISSING', 'REVIEW_REQUIRED')}`,
    `  plan sha256         : ${plan.planSha256}`,
  ].join('\n');
}
