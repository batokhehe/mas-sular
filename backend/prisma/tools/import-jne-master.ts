/**
 * PAXELBOX-61E: operator-controlled import of the JNE master data.
 *
 * ---------------------------------------------------------------------------
 * SHAPE, AND WHY
 *
 * This follows `import-regions.ts`: it reads a captured snapshot and makes no HTTP
 * request, so running it can never spend JNE quota or change what was observed.
 * jne-master-plan.ts decides what an import would do; this file reads, reports and
 * writes.
 *
 * ---------------------------------------------------------------------------
 * FOUR MODES, EACH STATED ON THE COMMAND LINE
 *
 * Offline (default): parse and report the snapshot. Never opens a database.
 *
 *   npx tsx prisma/tools/import-jne-master.ts --snapshot <file> --source PRODUCTION [--emit <out.json>]
 *
 * Live dry run: diff the snapshot against the whole stored master and its mappings
 * inside a READ ONLY transaction, and write the reports. PostgreSQL itself refuses a
 * write here.
 *
 *   ... --snapshot <file> --source PRODUCTION --metadata <fetch-metadata.json> --kind ORIGIN|DESTINATION
 *       --live-dry-run --report-dir <new dir>
 *
 * Import: one serializable transaction that writes everything or nothing, only rows
 * that differ, and only rows of --kind: the other kind is fingerprinted and any change
 * to it rolls the import back. It needs the reviewed count, checksum and plan hash, because JNE
 * publishes no total count and HTTP 200 does not show the response was complete.
 *
 *   ... --expect-records N --expect-unique-codes N --expect-sha256 <hex> --expect-plan <hex>
 *       [--reviewed-renames <file.csv> --reviewed-by "<who>"] --report-dir <new dir> --confirm
 *
 * Deactivation: never a side effect of an import. Explicit codes, each absent from
 * the reviewed snapshot, active, with no active mapping. Dry run unless --confirm.
 *
 *   ... --deactivate-missing <codes.csv> --expect-count N --reason "<why>" --operator "<who>"
 *       --expect-records N --expect-unique-codes N --expect-sha256 <hex> --report-dir <new dir> [--confirm]
 *
 * Without --metadata a capture may still carry its own date (61C envelope); a bare
 * `{detail}` file has none, and an import refuses to invent one.
 *
 * `--source` has no default and is recorded on every row. For PRODUCTION it is checked
 * against --metadata and against JNE_ENVIRONMENT / JNE_BASE_URL where the tool runs.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Prisma } from '@prisma/client';

import { parseCsvRecords, toCsv } from './csv';
import { inspectJneMasterPayload, toJneLocationSeeds, type JneDataSource, type JneLocationKind, type JneLocationSeed, type JneMasterInspection } from './jne-master';
import {
  formatPlan,
  locationFingerprint,
  planMasterImport,
  type ExistingLocation,
  type ExistingMapping,
  type MasterImportPlan,
  type MissingLocation,
  type PlanInput,
  type ReviewedRename,
  type SnapshotExpectations,
  type SnapshotProvenance,
  type TargetEnvironment,
} from './jne-master-plan';

export const CONFIRM_FLAG = '--confirm';
/** Rows per statement. Every chunk runs inside the ONE transaction. */
export const WRITE_CHUNK = 500;
/** A national master writes in well under a minute; this only bounds a stuck run. */
export const WRITE_TIMEOUT_MS = 300_000;
export const READ_TIMEOUT_MS = 60_000;
export const REASON_MIN = 10;

/** Flags of removed behaviour. Refused rather than ignored, so an old runbook fails loudly. */
export const RETIRED_FLAGS: Record<string, string> = {
  '--override-row-count': 'there is no row-count override: state the reviewed values with --expect-records, --expect-unique-codes and --expect-sha256',
};

/** Raised inside the transaction when the database no longer matches the plan. Rolls everything back. */
export class MasterChangedError extends Error {}

export interface ImportOptions {
  snapshotPath: string;
  emitPath: string;
  metadataPath: string;
  reportDir: string;
  reviewedRenamesPath: string;
  reviewedBy: string;
  deactivateMissingPath: string;
  reason: string;
  operator: string;
  expectCount?: number;
  confirmed: boolean;
  liveDryRun: boolean;
  kind: JneLocationKind;
  source: JneDataSource;
  expected: SnapshotExpectations;
}

function countFlag(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number, got "${raw}"`);
  return n;
}

export function parseArgs(argv: string[]): ImportOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const [flag, message] of Object.entries(RETIRED_FLAGS)) {
    if (argv.includes(flag)) throw new Error(`${flag}: ${message}`);
  }
  const kind = get('--kind');
  if (kind && kind !== 'ORIGIN' && kind !== 'DESTINATION') {
    throw new Error(`--kind must be ORIGIN or DESTINATION, got "${kind}"`);
  }
  const source = get('--source');
  if (source === undefined) {
    throw new Error('--source SANDBOX|PRODUCTION is required: name the JNE environment the snapshot came from (there is no default)');
  }
  if (source !== 'SANDBOX' && source !== 'PRODUCTION') {
    throw new Error(`--source must be SANDBOX or PRODUCTION, got "${source}"`);
  }
  return {
    snapshotPath: get('--snapshot') ?? '',
    emitPath: get('--emit') ?? '',
    metadataPath: get('--metadata') ?? '',
    reportDir: get('--report-dir') ?? '',
    reviewedRenamesPath: get('--reviewed-renames') ?? '',
    reviewedBy: get('--reviewed-by') ?? '',
    deactivateMissingPath: get('--deactivate-missing') ?? '',
    reason: get('--reason') ?? '',
    operator: get('--operator') ?? '',
    expectCount: countFlag('--expect-count', get('--expect-count')),
    confirmed: argv.includes(CONFIRM_FLAG),
    liveDryRun: argv.includes('--live-dry-run'),
    kind: (kind as JneLocationKind) ?? 'DESTINATION',
    source: source as JneDataSource,
    expected: {
      records: countFlag('--expect-records', get('--expect-records')),
      uniqueCodes: countFlag('--expect-unique-codes', get('--expect-unique-codes')),
      sha256: get('--expect-sha256'),
      planSha256: get('--expect-plan'),
    },
  };
}

/**
 * A 61C-style capture: `{ status, headers, text }` where `text` is the verbatim
 * response body. A bare `{ detail: [...] }` payload is accepted too, so a
 * snapshot taken any other way still works.
 */
export function extractPayload(fileContents: string): { payload: unknown; fetchedAt: string | null } {
  const outer = JSON.parse(fileContents) as { status?: number; text?: string; headers?: Array<[string, string]> };
  if (typeof outer?.text === 'string') {
    if (outer.status !== undefined && outer.status !== 200) {
      throw new Error(`snapshot records HTTP ${outer.status}; refusing to import a non-200 capture`);
    }
    const date = outer.headers?.find(([k]) => k.toLowerCase() === 'date')?.[1] ?? null;
    return { payload: JSON.parse(outer.text), fetchedAt: date };
  }
  return { payload: outer, fetchedAt: null };
}

/** Read a fetch-metadata.json. Anything missing is an error: this file is the evidence. */
export function parseProvenance(fileContents: string): SnapshotProvenance {
  const m = JSON.parse(fileContents) as {
    environment?: unknown;
    request?: { method?: unknown; url?: unknown };
    httpStatus?: unknown;
    bodySha256?: unknown;
    requestStartedUtc?: unknown;
  };
  const p = {
    environment: m.environment,
    method: m.request?.method,
    url: m.request?.url,
    httpStatus: m.httpStatus,
    bodySha256: m.bodySha256,
    requestStartedUtc: m.requestStartedUtc,
  };
  for (const [field, value] of Object.entries(p)) {
    if (value === undefined || value === null || value === '') throw new Error(`snapshot metadata has no ${field}`);
  }
  return p as SnapshotProvenance;
}

export function parseReviewedRenames(text: string): ReviewedRename[] {
  const { records } = parseCsvRecords(text, ['code', 'from_raw_name', 'to_raw_name']);
  const seen = new Set<string>();
  return records.map(({ values }) => {
    if (seen.has(values.code)) throw new Error(`reviewed renames list ${values.code} twice`);
    seen.add(values.code);
    return { code: values.code, from: values.from_raw_name, to: values.to_raw_name };
  });
}

export function parseCodeList(text: string): string[] {
  const codes = parseCsvRecords(text, ['code']).records.map(({ values }) => values.code);
  const repeated = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (repeated.length > 0) throw new Error(`code list repeats ${repeated.join(', ')}`);
  return codes;
}

/**
 * Verify every seed still carries its source row verbatim. This is the strongest
 * guarantee the phase asks for, so it is checked rather than assumed: a
 * normalisation bug that rewrote `rawName` would otherwise be invisible.
 */
export function verifyRawNames(
  seeds: JneLocationSeed[],
  rows: Array<{ City_Name: string; City_Code: string }>,
): { checked: number; mismatches: Array<{ code: string; expected: string; actual: string }> } {
  const byCode = new Map(rows.map((r) => [r.City_Code, r.City_Name]));
  const mismatches: Array<{ code: string; expected: string; actual: string }> = [];
  for (const s of seeds) {
    const expected = byCode.get(s.code);
    if (expected === undefined || expected !== s.rawName) {
      mismatches.push({ code: s.code, expected: expected ?? '<absent>', actual: s.rawName });
    }
  }
  return { checked: seeds.length, mismatches };
}

export interface LoadedSnapshot {
  sha256: string;
  sourceFetchedAt: string | null;
  inspection: JneMasterInspection;
  seeds: JneLocationSeed[];
  provenance: SnapshotProvenance | null;
}

/** Bytes to seeds. The checksum is of the file as stored, and nothing below rewrites a name. */
export function loadSnapshot(bytes: Buffer, metadataText: string | null, kind: JneLocationKind, source: JneDataSource): LoadedSnapshot {
  const { payload, fetchedAt } = extractPayload(bytes.toString('utf8'));
  const provenance = metadataText === null ? null : parseProvenance(metadataText);
  const stated = provenance?.requestStartedUtc ?? fetchedAt;
  const parsed = stated === null ? Number.NaN : new Date(stated).getTime();
  const sourceFetchedAt = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();

  const inspection = inspectJneMasterPayload(payload);
  // The placeholder only reaches `--emit`: a run with no capture time is blocked before any write.
  const seeds = toJneLocationSeeds(inspection.rows, { kind, source, sourceFetchedAt: sourceFetchedAt ?? '' });
  const verification = verifyRawNames(seeds, inspection.rows);
  if (verification.mismatches.length > 0) {
    throw new Error(`rawName was not preserved for ${verification.mismatches.length} row(s) - refusing to continue`);
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), sourceFetchedAt, inspection, seeds, provenance };
}

/** The slice of PrismaClient this tool uses, so the run is testable without a database. */
export interface MasterStore {
  jneLocation: {
    findMany(args: unknown): Promise<ExistingLocation[]>;
    createMany(args: { data: Prisma.JneLocationCreateManyInput[] }): Promise<{ count: number }>;
    update(args: { where: Prisma.JneLocationWhereUniqueInput; data: Prisma.JneLocationUpdateInput }): Promise<unknown>;
    updateMany(args: { where: Prisma.JneLocationWhereInput; data: Prisma.JneLocationUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  jneDistrictMapping: { findMany(args: unknown): Promise<MappingRow[]> };
  $executeRawUnsafe(query: string): Promise<number>;
  $transaction<T>(fn: (tx: MasterStore) => Promise<T>, options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

type MappingRow = {
  id: string;
  status: string;
  isActive: boolean;
  district: { code: string; name: string };
  jneLocation: { code: string; kind: JneLocationKind };
};

const LOCATION_SELECT = {
  id: true,
  code: true,
  kind: true,
  source: true,
  rawName: true,
  isActive: true,
  sourceFetchedAt: true,
  normalizedName: true,
  parsedChild: true,
  parsedParent: true,
  partCount: true,
  createdAt: true,
  updatedAt: true,
} as const;
const MAPPING_SELECT = {
  id: true,
  status: true,
  isActive: true,
  district: { select: { code: true, name: true } },
  jneLocation: { select: { code: true, kind: true } },
} as const;

export interface MasterState {
  existing: ExistingLocation[];
  mappings: ExistingMapping[];
}

/** The WHOLE master, both kinds, plus every mapping. Scoping to one kind is the planner's job. */
export async function readMasterState(store: Pick<MasterStore, 'jneLocation' | 'jneDistrictMapping'>): Promise<MasterState> {
  const existing = await store.jneLocation.findMany({ select: LOCATION_SELECT } satisfies Prisma.JneLocationFindManyArgs);
  const rows = await store.jneDistrictMapping.findMany({ select: MAPPING_SELECT } satisfies Prisma.JneDistrictMappingFindManyArgs);
  const mappings = rows.map((m) => ({
    id: m.id,
    status: m.status,
    isActive: m.isActive,
    districtCode: m.district.code,
    districtName: m.district.name,
    jneCode: m.jneLocation.code,
    kind: m.jneLocation.kind,
  }));
  // A stable order, so a plan hash depends only on content.
  existing.sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
  mappings.sort((a, b) => a.id.localeCompare(b.id));
  return { existing, mappings };
}

type PlanBuilder = (state: MasterState) => MasterImportPlan;

/** Reads in a READ ONLY transaction: a stray write here is an error from PostgreSQL, not a promise. */
export async function runLiveDryRun(store: MasterStore, build: PlanBuilder, log: (line: string) => void = console.log): Promise<MasterImportPlan> {
  const plan = await store.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return build(await readMasterState(tx));
    },
    { timeout: READ_TIMEOUT_MS, isolationLevel: 'RepeatableRead' as Prisma.TransactionIsolationLevel },
  );
  log('live dry run (read-only transaction):');
  log(formatPlan(plan));
  for (const w of plan.warnings) log(`  warning: ${w}`);
  for (const b of plan.blockers) log(`  BLOCKER ${b.code}: ${b.detail}`);
  log(plan.blockers.length ? `an import would be refused: ${plan.blockers.length} blocker(s).` : 'no blockers. Nothing was written.');
  return plan;
}

function mappingsKey(state: MasterState): string {
  return JSON.stringify(state.mappings);
}

async function writePlan(tx: MasterStore, plan: MasterImportPlan): Promise<void> {
  const fetchedAt = new Date(plan.sourceFetchedAt as string);
  // `kind` is in every write as well as in the plan: a row of the protected kind cannot
  // match, and a count that comes up short rolls the import back.
  const { kind } = plan;
  if ([...plan.created, ...plan.updated.map((u) => u.seed)].some((s) => s.kind !== kind)) {
    throw new MasterChangedError(`a seed is not ${kind}; nothing written`);
  }
  for (let i = 0; i < plan.created.length; i += WRITE_CHUNK) {
    const data = plan.created.slice(i, i + WRITE_CHUNK).map((s) => ({ ...s, sourceFetchedAt: fetchedAt }));
    // No skipDuplicates: a row appearing since the plan fails the transaction.
    const { count } = await tx.jneLocation.createMany({ data });
    if (count !== data.length) throw new MasterChangedError(`inserted ${count} of ${data.length} row(s)`);
  }
  const renamed = plan.updated.filter((u) => u.changes.includes('rawName'));
  for (const { id, seed } of renamed) {
    await tx.jneLocation.update({
      where: { id, kind },
      data: {
        rawName: seed.rawName,
        normalizedName: seed.normalizedName,
        parsedChild: seed.parsedChild,
        parsedParent: seed.parsedParent,
        partCount: seed.partCount,
        source: seed.source,
        sourceFetchedAt: fetchedAt,
        isActive: seed.isActive,
      },
    });
  }
  // Everything else differs only in provenance or activity, which is the same for every
  // row: seeds that reach a plan are all active. `id` is the key, so references hold.
  const others = plan.updated.filter((u) => !u.changes.includes('rawName'));
  for (let i = 0; i < others.length; i += WRITE_CHUNK) {
    const ids = others.slice(i, i + WRITE_CHUNK).map((u) => u.id);
    const { count } = await tx.jneLocation.updateMany({
      where: { id: { in: ids }, kind },
      data: { source: plan.source, sourceFetchedAt: fetchedAt, isActive: true },
    });
    if (count !== ids.length) throw new MasterChangedError(`updated ${count} of ${ids.length} row(s)`);
  }
}

function protectedFingerprintOf(plan: MasterImportPlan, state: MasterState): string {
  return locationFingerprint(state.existing.filter((e) => e.kind === plan.protectedKind));
}

/** Checked before commit: a wrong result rolls back instead of being discovered later. */
function verifyWritten(plan: MasterImportPlan, before: MasterState, after: MasterState): void {
  const fail = (why: string) => {
    throw new MasterChangedError(`post-write check failed: ${why}; nothing written`);
  };
  const rows = new Map(after.existing.filter((e) => e.kind === plan.kind).map((e) => [e.code, e]));
  for (const seed of [...plan.created, ...plan.updated.map((u) => u.seed)]) {
    const row = rows.get(seed.code);
    if (!row) fail(`${seed.code} is absent`);
    else if (row.rawName !== seed.rawName || row.source !== plan.source || !row.isActive) fail(`${seed.code} does not match its snapshot row`);
    else if (new Date(row.sourceFetchedAt).toISOString() !== plan.sourceFetchedAt) fail(`${seed.code} has the wrong fetch time`);
  }
  const idsAfter = new Set(after.existing.map((e) => e.id));
  if (before.existing.some((e) => !idsAfter.has(e.id))) fail('a location id disappeared');
  if (after.existing.length !== before.existing.length + plan.created.length) fail('the row count is not the planned one');
  // Rows the plan leaves alone, missing codes among them: nothing about them may move.
  const written = new Set(plan.updated.map((u) => u.id));
  const untouched = before.existing.filter((e) => e.kind === plan.kind && !written.has(e.id));
  const untouchedIds = new Set(untouched.map((e) => e.id));
  if (locationFingerprint(untouched) !== locationFingerprint(after.existing.filter((e) => untouchedIds.has(e.id)))) fail('a row outside the plan changed');
  if (mappingsKey(before) !== mappingsKey(after)) fail('a mapping changed');
  if (protectedFingerprintOf(plan, after) !== plan.protectedFingerprint) fail(`the ${plan.protectedKind} master changed`);
}

export interface ImportResult {
  code: number;
  plan: MasterImportPlan;
  written: number;
}

/**
 * Write a blocker-free plan. ONE serializable transaction: the plan is rebuilt from
 * what the transaction sees and must equal the one reviewed, every change is applied,
 * the result is checked, and only then does it commit. Any failure leaves the master
 * as it was. Rows that already match are not touched, so re-running an import writes
 * nothing and moves no `updatedAt`.
 */
export async function runImport(store: MasterStore, build: PlanBuilder, log: (line: string) => void = console.log): Promise<ImportResult> {
  const plan = build(await readMasterState(store));
  log('import diff (against the live master):');
  log(formatPlan(plan));
  for (const w of plan.warnings) log(`  warning: ${w}`);
  if (plan.blockers.length > 0) {
    for (const b of plan.blockers) log(`  BLOCKER ${b.code}: ${b.detail}`);
    log(`refusing to write: ${plan.blockers.length} blocker(s). Nothing was written.`);
    return { code: 4, plan, written: 0 };
  }
  const written = plan.created.length + plan.updated.length;
  if (written === 0) {
    log('nothing to write: the stored master already equals this snapshot.');
    return { code: 0, plan, written: 0 };
  }
  await store.$transaction(
    async (tx) => {
      const before = await readMasterState(tx);
      const again = build(before);
      if (again.planSha256 !== plan.planSha256 || again.blockers.length > 0) {
        throw new MasterChangedError('the master or its mappings changed since the plan; nothing written - re-run the dry run');
      }
      await writePlan(tx, again);
      verifyWritten(again, before, await readMasterState(tx));
    },
    { timeout: WRITE_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`wrote ${plan.created.length} new and ${plan.updated.length} changed row(s); ${plan.missing.length} missing code(s) left as they were.`);
  log('mappings were not touched. Missing codes are reported in the report directory.');
  return { code: 0, plan, written };
}

export interface DeactivationRequest {
  codes: string[];
  expectCount?: number;
  reason: string;
  operator: string;
  confirm: boolean;
}

export interface DeactivationResult {
  code: number;
  refused: string[];
  targets: MissingLocation[];
  written: number;
}

/** Why each listed code may not be deactivated. Empty means the whole list may be. */
export function deactivationRefusals(plan: MasterImportPlan, request: DeactivationRequest): string[] {
  const refused: string[] = [];
  if (request.expectCount !== request.codes.length) {
    refused.push(`--expect-count is ${request.expectCount ?? 'absent'} but the list has ${request.codes.length} code(s)`);
  }
  if (request.reason.trim().length < REASON_MIN) refused.push(`--reason must explain the deactivation (at least ${REASON_MIN} characters)`);
  if (!request.operator.trim()) refused.push('--operator is required');
  if (plan.blockers.length > 0) refused.push(...plan.blockers.map((b) => `${b.code}: ${b.detail}`));
  if (plan.created.length + plan.updated.length > 0) refused.push('import this snapshot first: a code is only "missing" against a master that holds the snapshot');
  const missing = new Map(plan.missing.map((m) => [m.code, m]));
  for (const code of request.codes) {
    const m = missing.get(code);
    if (!m) refused.push(`${code} is not a missing code of this snapshot`);
    else if (!m.isActive) refused.push(`${code} is already inactive`);
    else if (m.activeMatched + m.activeReview > 0) refused.push(`${code} has ${m.activeMatched + m.activeReview} active mapping(s): retire them first with deactivate-jne-mappings.ts`);
  }
  return refused;
}

/** All listed codes or none, in one serializable transaction that re-checks every one of them. */
export async function runDeactivateMissing(
  store: MasterStore,
  build: PlanBuilder,
  request: DeactivationRequest,
  log: (line: string) => void = console.log,
): Promise<DeactivationResult> {
  const plan = build(await readMasterState(store));
  const refused = deactivationRefusals(plan, request);
  const listed = new Set(request.codes);
  const targets = plan.missing.filter((m) => listed.has(m.code));
  for (const r of refused) log(`  REFUSED ${r}`);
  if (refused.length > 0) {
    log(`refusing to deactivate: ${refused.length} problem(s). Nothing was written.`);
    return { code: 4, refused, targets, written: 0 };
  }
  log(`deactivation of ${targets.length} code(s) by ${request.operator}: ${request.reason}`);
  if (!request.confirm) {
    log('dry run: nothing written. Re-run with --confirm to deactivate exactly these codes.');
    return { code: 0, refused, targets, written: 0 };
  }
  const written = await store.$transaction(
    async (tx) => {
      const again = build(await readMasterState(tx));
      const problems = deactivationRefusals(again, request);
      if (problems.length > 0) throw new MasterChangedError(`state changed since the check: ${problems[0]}; nothing written`);
      const ids = again.missing.filter((m) => listed.has(m.code)).map((m) => m.id);
      const { count } = await tx.jneLocation.updateMany({ where: { id: { in: ids }, kind: again.kind, isActive: true }, data: { isActive: false } });
      if (count !== request.codes.length) throw new MasterChangedError(`deactivated ${count} of ${request.codes.length} code(s); nothing written`);
      if (protectedFingerprintOf(again, await readMasterState(tx)) !== again.protectedFingerprint) {
        throw new MasterChangedError(`the ${again.protectedKind} master changed; nothing written`);
      }
      return count;
    },
    { timeout: WRITE_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`deactivated ${written} code(s). Rows are kept; mappings were not touched.`);
  return { code: 0, refused, targets, written };
}

/** The machine-readable record of a run. Holds the provenance and no credential. */
export function planSummary(plan: MasterImportPlan, provenance: SnapshotProvenance | null) {
  return {
    kind: plan.kind,
    source: plan.source,
    snapshotSha256: plan.snapshotSha256,
    sourceFetchedAt: plan.sourceFetchedAt,
    provenance,
    planSha256: plan.planSha256,
    records: plan.records,
    uniqueCodes: plan.uniqueCodes,
    accepted: plan.accepted,
    duplicates: plan.duplicates.length,
    invalid: plan.invalid.length,
    testCodes: plan.testCodes,
    existingBySource: plan.existingBySource,
    alsoInOtherKind: plan.alsoInOtherKind,
    protectedKind: plan.protectedKind,
    protectedRows: plan.protectedRows.length,
    protectedFingerprint: plan.protectedFingerprint,
    unchanged: plan.unchanged,
    new: plan.created.length,
    changed: plan.updated.length,
    renamed: plan.updated.filter((u) => u.changes.includes('rawName')).length,
    missing: plan.missing.length,
    missingActive: plan.missing.filter((m) => m.isActive).length,
    warnings: plan.warnings,
    blockers: plan.blockers,
  };
}

/** Reports go to a NEW directory: a run never overwrites an earlier report or a snapshot. */
export function writeReports(dir: string, plan: MasterImportPlan, provenance: SnapshotProvenance | null, extra: Record<string, unknown> = {}): void {
  if (existsSync(dir)) throw new Error(`--report-dir ${dir} already exists; use a new directory`);
  mkdirSync(dir, { recursive: true });
  const put = (name: string, text: string) => writeFileSync(join(dir, name), text, { flag: 'wx' });
  put('plan.json', `${JSON.stringify({ ...planSummary(plan, provenance), ...extra }, null, 2)}\n`);
  put('new.csv', toCsv(['code', 'raw_name'], plan.created.map((s) => ({ code: s.code, raw_name: s.rawName }))));
  put(
    'changed.csv',
    toCsv(
      ['code', 'changes', 'from_source', 'to_source', 'from_raw_name', 'to_raw_name'],
      plan.updated.map((u) => ({ code: u.code, changes: u.changes.join('+'), from_source: u.fromSource, to_source: u.seed.source, from_raw_name: u.fromRawName, to_raw_name: u.seed.rawName })),
    ),
  );
  put(
    'renames-to-review.csv',
    toCsv(
      ['code', 'from_raw_name', 'to_raw_name'],
      plan.updated
        .filter((u) => u.changes.includes('rawName'))
        .map((u) => ({ code: u.code, from_raw_name: u.fromRawName, to_raw_name: u.seed.rawName })),
    ),
  );
  put(
    'missing.csv',
    toCsv(
      ['code', 'source', 'raw_name', 'is_active', 'active_matched', 'active_review'],
      plan.missing.map((m) => ({ code: m.code, source: m.source, raw_name: m.rawName, is_active: m.isActive, active_matched: m.activeMatched, active_review: m.activeReview })),
    ),
  );
  put(
    'mapping-impact.csv',
    toCsv(
      ['district_code', 'district', 'jne_code', 'status', 'is_active', 'state', 'from_raw_name', 'to_raw_name'],
      plan.mappingImpact.map((m) => ({
        district_code: m.districtCode,
        district: m.districtName,
        jne_code: m.jneCode,
        status: m.status,
        is_active: m.isActive,
        state: m.state,
        from_raw_name: m.fromRawName ?? '',
        to_raw_name: m.toRawName ?? '',
      })),
    ),
  );
  const protectedColumns = ['id', 'code', 'kind', 'source', 'rawName', 'normalizedName', 'parsedChild', 'parsedParent', 'partCount', 'isActive', 'sourceFetchedAt', 'createdAt', 'updatedAt'] as const;
  const isoDates = (r: ExistingLocation) => ({ ...r, sourceFetchedAt: new Date(r.sourceFetchedAt).toISOString(), createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() });
  put('protected-kind-snapshot.csv', toCsv(protectedColumns, plan.protectedRows.map(isoDates)));
  put('invalid.csv', toCsv(['row', 'code', 'name', 'reason'], plan.invalid.map((i) => ({ row: i.row, code: i.code ?? '', name: i.name ?? '', reason: i.reason }))));
  put('duplicates.csv', toCsv(['code', 'rows'], plan.duplicates.map((d) => ({ code: d.code, rows: d.rows.join(' ') }))));
}

export function targetFromEnv(env: NodeJS.ProcessEnv): TargetEnvironment {
  return { jneEnvironment: env.JNE_ENVIRONMENT, jneBaseUrl: env.JNE_BASE_URL, jneOriginCode: env.JNE_ORIGIN_CODE };
}

export function usageProblem(opts: ImportOptions): string | null {
  if (!opts.snapshotPath) return 'missing --snapshot <path to the captured master response>';
  const live = opts.liveDryRun || opts.confirmed || opts.deactivateMissingPath !== '';
  if (live && !opts.reportDir) return '--report-dir <new directory> is required for a run against a database';
  if (opts.liveDryRun && opts.confirmed) return '--live-dry-run and --confirm are mutually exclusive';
  if (opts.reviewedRenamesPath && !opts.reviewedBy.trim()) return '--reviewed-renames needs --reviewed-by "<who>"';
  return null;
}

export type OpenStore = () => { store: MasterStore; close: () => Promise<void> };

export const openPrismaStore: OpenStore = () => {
  // Prisma is required LAZILY, so the offline mode has no database dependency at all.
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  return { store: prisma as unknown as MasterStore, close: () => prisma.$disconnect() };
};

export async function main(
  argv: string[],
  openStore: OpenStore = openPrismaStore,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  const opts = parseArgs(argv);
  const problem = usageProblem(opts);
  if (problem) {
    log(problem);
    return 2;
  }

  const loaded = loadSnapshot(readFileSync(opts.snapshotPath), opts.metadataPath ? readFileSync(opts.metadataPath, 'utf8') : null, opts.kind, opts.source);
  const { inspection, seeds, sha256, sourceFetchedAt, provenance } = loaded;

  log(`snapshot: ${opts.snapshotPath}`);
  log(`kind=${opts.kind} source=${opts.source} sourceFetchedAt=${sourceFetchedAt ?? 'unknown'} sha256=${sha256}`);
  log(`records ${inspection.records}, unique codes ${inspection.uniqueCodes}, duplicates ${inspection.duplicates.length}, invalid ${inspection.invalid.length}, test codes ${inspection.testCodes.length}`);
  log(`rawName preserved for ${seeds.length}/${seeds.length} row(s), 0 mismatches`);

  if (opts.emitPath) {
    writeFileSync(opts.emitPath, `${JSON.stringify(seeds, null, 2)}\n`, 'utf8');
    log(`emitted ${seeds.length} seed row(s) -> ${opts.emitPath}`);
  }

  const deactivating = opts.deactivateMissingPath !== '';
  if (!opts.liveDryRun && !opts.confirmed && !deactivating) {
    log(`\nno database contact. Pass --live-dry-run to diff against the live master, ${CONFIRM_FLAG} to persist.`);
    return 0;
  }
  // Checked before any database work: a committed import must always leave its report.
  if (existsSync(opts.reportDir)) {
    log(`--report-dir ${opts.reportDir} already exists; use a new directory`);
    return 2;
  }

  const reviewedRenames = opts.reviewedRenamesPath ? parseReviewedRenames(readFileSync(opts.reviewedRenamesPath, 'utf8')) : [];
  const planInput: Omit<PlanInput, 'existing' | 'mappings'> = {
    kind: opts.kind,
    source: opts.source,
    sha256,
    sourceFetchedAt,
    inspection,
    seeds,
    reviewedRenames,
    provenance,
    target: targetFromEnv(env),
    expected: opts.expected,
    requireExpectations: opts.confirmed || deactivating,
  };
  const build: PlanBuilder = (state) => planMasterImport({ ...planInput, ...state });

  const { store, close } = openStore();
  try {
    if (deactivating) {
      const result = await runDeactivateMissing(
        store,
        build,
        { codes: parseCodeList(readFileSync(opts.deactivateMissingPath, 'utf8')), expectCount: opts.expectCount, reason: opts.reason, operator: opts.operator, confirm: opts.confirmed },
        log,
      );
      const plan = build(await readMasterState(store));
      writeReports(opts.reportDir, plan, provenance, {
        action: opts.confirmed ? 'DEACTIVATE_MISSING' : 'DEACTIVATE_MISSING_DRY_RUN',
        operator: opts.operator,
        reason: opts.reason,
        deactivated: result.written,
        codes: result.targets.map((t) => t.code),
        refused: result.refused,
      });
      return result.code;
    }
    if (opts.liveDryRun) {
      writeReports(opts.reportDir, await runLiveDryRun(store, build, log), provenance, { action: 'LIVE_DRY_RUN' });
      return 0;
    }
    const result = await runImport(store, build, log);
    writeReports(opts.reportDir, result.plan, provenance, {
      action: 'IMPORT',
      written: result.written,
      reviewedBy: opts.reviewedBy || null,
      reviewedRenames,
    });
    return result.code;
  } finally {
    await close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
