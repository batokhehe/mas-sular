/**
 * Reactivate retired JNE destination mappings from an exact reviewed file: the reverse of
 * deactivate-jne-mappings.ts, and the only way a retired mapping comes back. An import, a
 * manifest, the candidate generator or a matching code never does it.
 *
 *   npx tsx prisma/tools/reactivate-jne-mappings.ts --prepare <pairs.csv> --out <review.csv>
 *     read-only: writes one review row per retired pair (district_code, jne_code) with the
 *     values a reviewer must confirm. reviewer, reason and review_reference stay blank.
 *   npx tsx prisma/tools/reactivate-jne-mappings.ts --review-file <review.csv> --operator "<who>"
 *     dry run (the default): checks every row, prints the plan hash, writes nothing.
 *   ... --confirm --expect-count N --expect-plan <hex>
 *     sets isActive=true on exactly the listed rows, in one serializable transaction, or on
 *     none of them.
 *
 * It restores the SAME row: the id, district, JNE location, status, method, evidence and the
 * original reviewedBy/reviewedAt stay as they are. Only isActive changes, and the action is
 * appended to `notes`, as a retirement is. Nothing here touches JneLocation.
 *
 * A review names the row's exact state, including its updatedAt, so a review of an earlier
 * state of the row is refused. A row that is already active is refused, not skipped: a
 * repeated run changes nothing and says why.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { JneMappingStatus, Prisma } from '@prisma/client';
import { parseCsvRecords, toCsv } from './csv';

export const REVIEW_COLUMNS = [
  'mapping_id',
  'district_code',
  'jne_code',
  'expected_status',
  'expected_is_active',
  'expected_updated_at',
  'reviewer',
  'reason',
  'review_reference',
] as const;
export const PREPARE_COLUMNS = ['district_code', 'jne_code'] as const;
export const REASON_MIN = 10;
export const REACTIVATION_TIMEOUT_MS = 120_000;
/** Statuses a retired row can return to. AMBIGUOUS and NOT_FOUND never resolved anything. */
export const REACTIVATABLE_STATUSES = ['MATCHED', 'REVIEW_REQUIRED'] as const;

export interface ReviewRow {
  record: number;
  mappingId: string;
  districtCode: string;
  jneCode: string;
  expectedStatus: string;
  expectedIsActive: string;
  expectedUpdatedAt: string;
  reviewer: string;
  reason: string;
  reviewReference: string;
}

export function parseReview(text: string): ReviewRow[] {
  return parseCsvRecords(text, REVIEW_COLUMNS).records.map(({ record, values: v }) => ({
    record,
    mappingId: v.mapping_id.trim(),
    districtCode: v.district_code.trim(),
    jneCode: v.jne_code.trim().toUpperCase(),
    expectedStatus: v.expected_status.trim(),
    expectedIsActive: v.expected_is_active.trim().toLowerCase(),
    expectedUpdatedAt: v.expected_updated_at.trim(),
    reviewer: v.reviewer.trim(),
    reason: v.reason.trim(),
    reviewReference: v.review_reference.trim(),
  }));
}

/** One mapping row as the decision saw it. */
export interface MappingState {
  id: string;
  districtId: string;
  districtCode: string;
  districtActive: boolean;
  jneLocationId: string;
  jneCode: string;
  kind: string;
  locationActive: boolean;
  status: string;
  isActive: boolean;
  updatedAt: Date;
  notes: string | null;
}

export type ReactivationDecision =
  | { row: ReviewRow; outcome: 'REACTIVATE'; mapping: MappingState }
  | { row: ReviewRow; outcome: 'REFUSE'; reason: string };

function refusal(row: ReviewRow, m: MappingState | undefined, others: MappingState[]): string | null {
  if (!row.reviewer) return 'reviewer is required';
  if (row.reason.length < REASON_MIN) return `reason is required (at least ${REASON_MIN} characters)`;
  if (!row.reviewReference) return 'review_reference is required';
  if (!m) return `no mapping ${row.mappingId}`;
  if (m.districtCode !== row.districtCode) return `mapping belongs to district ${m.districtCode}, not ${row.districtCode}`;
  if (m.jneCode !== row.jneCode) return `mapping points at ${m.jneCode}, not ${row.jneCode}`;
  if (m.status !== row.expectedStatus) return `status is ${m.status}, the review says ${row.expectedStatus}`;
  if (row.expectedIsActive !== 'false') return 'expected_is_active must be false: only a retired mapping can be reactivated';
  if (m.isActive) return 'mapping is already active';
  const reviewed = new Date(row.expectedUpdatedAt).getTime();
  if (Number.isNaN(reviewed) || reviewed !== m.updatedAt.getTime()) return `row was last changed at ${m.updatedAt.toISOString()}, the review says ${row.expectedUpdatedAt}`;
  if (!(REACTIVATABLE_STATUSES as readonly string[]).includes(m.status)) return `a ${m.status} mapping cannot be reactivated`;
  if (m.kind !== 'DESTINATION') return `mapping points at a ${m.kind} row`;
  if (!m.locationActive) return `JNE location ${m.jneCode} is inactive`;
  if (!m.districtActive) return 'the district (or its city) is inactive';
  const conflict = others.find((o) => o.isActive && (o.status === 'MATCHED' || o.status === 'REVIEW_REQUIRED'));
  if (conflict) return `district already has an active ${conflict.status} mapping for ${conflict.jneCode}`;
  return null;
}

/** Pure decision for every reviewed row, given every mapping of the listed districts. */
export function decideReactivations(rows: ReviewRow[], mappings: MappingState[]): ReactivationDecision[] {
  const byId = new Map(mappings.map((m) => [m.id, m]));
  const idCount = new Map<string, number>();
  const districtCount = new Map<string, number>();
  for (const r of rows) {
    idCount.set(r.mappingId, (idCount.get(r.mappingId) ?? 0) + 1);
    districtCount.set(r.districtCode, (districtCount.get(r.districtCode) ?? 0) + 1);
  }
  return [...rows]
    .sort((a, b) => a.districtCode.localeCompare(b.districtCode) || a.record - b.record)
    .map((row): ReactivationDecision => {
      if ((idCount.get(row.mappingId) as number) > 1) return { row, outcome: 'REFUSE', reason: 'mapping listed more than once' };
      // Two rows for one district would each pass alone and still leave two active.
      if ((districtCount.get(row.districtCode) as number) > 1) return { row, outcome: 'REFUSE', reason: 'district listed more than once' };
      const m = byId.get(row.mappingId);
      const others = m ? mappings.filter((o) => o.districtId === m.districtId && o.id !== m.id) : [];
      const reason = refusal(row, m, others);
      return reason ? { row, outcome: 'REFUSE', reason } : { row, outcome: 'REACTIVATE', mapping: m as MappingState };
    });
}

/** Identity of a reviewed reactivation: every reviewed value, and the operator. */
export function reactivationPlanHash(decisions: ReactivationDecision[], operator: string): string {
  const identity = decisions
    .map(({ row: r }) => [r.mappingId, r.districtCode, r.jneCode, r.expectedStatus, r.expectedIsActive, r.expectedUpdatedAt, r.reviewer, r.reason, r.reviewReference])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify({ operator, reviewed: identity })).digest('hex');
}

type MappingRow = {
  id: string;
  districtId: string;
  jneLocationId: string;
  status: string;
  isActive: boolean;
  updatedAt: Date;
  notes: string | null;
  district: { code: string; isActive: boolean; city: { isActive: boolean } };
  jneLocation: { code: string; kind: string; isActive: boolean };
};

export interface ReactivationStore {
  jneDistrictMapping: {
    findMany(args: unknown): Promise<MappingRow[]>;
    updateMany(args: { where: Prisma.JneDistrictMappingWhereInput; data: Prisma.JneDistrictMappingUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ReactivationStore) => Promise<T>, options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

const MAPPING_SELECT = {
  id: true,
  districtId: true,
  jneLocationId: true,
  status: true,
  isActive: true,
  updatedAt: true,
  notes: true,
  district: { select: { code: true, isActive: true, city: { select: { isActive: true } } } },
  jneLocation: { select: { code: true, kind: true, isActive: true } },
} as const;

async function readState(store: Pick<ReactivationStore, 'jneDistrictMapping'>, where: Prisma.JneDistrictMappingWhereInput): Promise<MappingState[]> {
  const found = await store.jneDistrictMapping.findMany({ where, select: MAPPING_SELECT } satisfies Prisma.JneDistrictMappingFindManyArgs);
  return found.map((m) => ({
    id: m.id,
    districtId: m.districtId,
    districtCode: m.district.code,
    districtActive: m.district.isActive && m.district.city.isActive,
    jneLocationId: m.jneLocationId,
    jneCode: m.jneLocation.code,
    kind: m.jneLocation.kind,
    locationActive: m.jneLocation.isActive,
    status: m.status,
    isActive: m.isActive,
    updatedAt: m.updatedAt,
    notes: m.notes,
  }));
}

/** Every row a decision needs: the reviewed ids, and all mappings of their claimed and actual districts. */
async function stateFor(store: Pick<ReactivationStore, 'jneDistrictMapping'>, rows: ReviewRow[]): Promise<MappingState[]> {
  const listed = await readState(store, { OR: [{ id: { in: rows.map((r) => r.mappingId) } }, { district: { code: { in: rows.map((r) => r.districtCode) } } }] });
  const districtIds = [...new Set(listed.map((m) => m.districtId))];
  return readState(store, { OR: [{ id: { in: rows.map((r) => r.mappingId) } }, { districtId: { in: districtIds } }] });
}

/** Read-only: one review row per retired pair, for a person to check and complete. */
export async function prepareReview(store: Pick<ReactivationStore, 'jneDistrictMapping'>, pairsText: string): Promise<string> {
  const pairs = parseCsvRecords(pairsText, PREPARE_COLUMNS).records.map(({ values }) => ({ districtCode: values.district_code.trim(), jneCode: values.jne_code.trim().toUpperCase() }));
  const state = await readState(store, { district: { code: { in: pairs.map((p) => p.districtCode) } } });
  const rows = pairs.map((p) => {
    const m = state.find((s) => s.districtCode === p.districtCode && s.jneCode === p.jneCode && s.kind === 'DESTINATION');
    if (!m) throw new Error(`no DESTINATION mapping for ${p.districtCode} -> ${p.jneCode}`);
    if (m.isActive) throw new Error(`${p.districtCode} -> ${p.jneCode} is active, there is nothing to reactivate`);
    return {
      mapping_id: m.id,
      district_code: m.districtCode,
      jne_code: m.jneCode,
      expected_status: m.status,
      expected_is_active: 'false',
      expected_updated_at: m.updatedAt.toISOString(),
      reviewer: '',
      reason: '',
      review_reference: '',
    };
  });
  return toCsv(REVIEW_COLUMNS, rows);
}

export interface ReactivationOptions {
  operator: string;
  confirm: boolean;
  expectCount?: number;
  expectPlan?: string;
}

/** Raised inside the transaction when a row no longer matches the review; nothing is written. */
export class MappingChangedError extends Error {}

export async function runReactivations(
  store: ReactivationStore,
  text: string,
  opts: ReactivationOptions,
  log: (line: string) => void = console.log,
  now: () => Date = () => new Date(),
): Promise<{ code: number; decisions: ReactivationDecision[]; reactivated: number; planSha256: string }> {
  const operator = opts.operator.trim();
  if (!operator) {
    log('--operator <who> is required: a reactivation must name a person');
    return { code: 2, decisions: [], reactivated: 0, planSha256: '' };
  }
  const rows = parseReview(text);
  if (rows.length === 0) {
    log('the review file lists no mapping');
    return { code: 2, decisions: [], reactivated: 0, planSha256: '' };
  }
  const decisions = decideReactivations(rows, await stateFor(store, rows));
  const planSha256 = reactivationPlanHash(decisions, operator);
  const targets = decisions.filter((d): d is Extract<ReactivationDecision, { outcome: 'REACTIVATE' }> => d.outcome === 'REACTIVATE');
  const refused = decisions.filter((d) => d.outcome === 'REFUSE');

  log(`reactivation by ${operator}: reactivate ${targets.length}   refused ${refused.length}`);
  for (const d of decisions) {
    const detail = d.outcome === 'REFUSE' ? `REFUSED ${d.reason}` : `${d.mapping.status}, inactive -> active, reviewed by ${d.row.reviewer}`;
    log(`  record ${d.row.record} ${d.row.mappingId} ${d.row.districtCode} -> ${d.row.jneCode}: ${detail}`);
  }
  log(`plan sha256: ${planSha256}`);

  if (!opts.confirm) {
    log(`dry run: nothing written. Re-run with --confirm --expect-count ${targets.length} --expect-plan ${planSha256} to reactivate.`);
    return { code: 0, decisions, reactivated: 0, planSha256 };
  }
  if (refused.length > 0) {
    log('refusing to write: fix or remove the refused rows first. Nothing was written.');
    return { code: 4, decisions, reactivated: 0, planSha256 };
  }
  if (opts.expectCount === undefined || opts.expectCount !== targets.length) {
    log(`refusing to write: ${targets.length} row(s) would change, --expect-count is ${opts.expectCount ?? 'absent'}.`);
    return { code: 5, decisions, reactivated: 0, planSha256 };
  }
  if (opts.expectPlan !== planSha256) {
    log(`refusing to write: PLAN_MISMATCH, this review is ${planSha256}, --expect-plan is ${opts.expectPlan ?? 'absent'}.`);
    return { code: 5, decisions, reactivated: 0, planSha256 };
  }

  const at = now();
  // One serializable transaction. Every row is decided again from what the transaction
  // sees, so a mapping approved for the district since the dry run stops the run, and the
  // partial unique index refuses a second active MATCHED row whatever else happens.
  const reactivated = await store.$transaction(
    async (tx) => {
      const again = decideReactivations(rows, await stateFor(tx, rows));
      const problem = again.find((d) => d.outcome === 'REFUSE');
      if (problem?.outcome === 'REFUSE') {
        throw new MappingChangedError(`record ${problem.row.record} changed since the dry run: ${problem.reason}; nothing reactivated`);
      }
      let n = 0;
      for (const d of again as Array<Extract<ReactivationDecision, { outcome: 'REACTIVATE' }>>) {
        const m = d.mapping;
        const audit =
          `[${at.toISOString()}] reactivated by ${operator}, reviewed by ${d.row.reviewer} (${d.row.reviewReference}): ${d.row.reason}; ` +
          `was ${m.status}/inactive, now ${m.status}/active`;
        const { count } = await tx.jneDistrictMapping.updateMany({
          where: {
            id: m.id,
            districtId: m.districtId,
            jneLocationId: m.jneLocationId,
            status: m.status as JneMappingStatus,
            isActive: false,
            updatedAt: m.updatedAt,
            jneLocation: { kind: 'DESTINATION', isActive: true },
            district: { isActive: true, city: { isActive: true } },
          },
          data: { isActive: true, notes: m.notes ? `${m.notes}\n${audit}` : audit },
        });
        if (count !== 1) throw new MappingChangedError(`record ${d.row.record} (${m.id}) changed since the dry run; nothing reactivated`);
        n += count;
      }
      return n;
    },
    { timeout: REACTIVATION_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`reactivated ${reactivated} mapping(s) by ${operator}`);
  return { code: 0, decisions, reactivated, planSha256 };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  const finish = (code: number) => prisma.$disconnect().then(() => process.exit(code));
  const fail = (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    return finish(1);
  };
  const store = prisma as unknown as ReactivationStore;
  const prepare = get('--prepare');
  const review = get('--review-file');
  if (prepare) {
    const out = get('--out');
    if (!out || existsSync(out)) {
      console.error('usage: --prepare <pairs.csv> --out <new review.csv>');
      process.exit(2);
    }
    prepareReview(store, readFileSync(prepare, 'utf8'))
      .then((csv) => {
        writeFileSync(out, csv, { flag: 'wx' });
        console.log(`review file: ${out}. Check every value, then fill reviewer, reason and review_reference.`);
        return finish(0);
      })
      .catch(fail);
  } else if (!review) {
    console.error('usage: --review-file <review.csv> --operator "<who>" [--confirm --expect-count N --expect-plan <hex>]');
    process.exit(2);
  } else {
    const expect = get('--expect-count');
    runReactivations(store, readFileSync(review, 'utf8'), {
      operator: get('--operator') ?? '',
      confirm: argv.includes('--confirm'),
      expectCount: expect === undefined ? undefined : Number(expect),
      expectPlan: get('--expect-plan'),
    })
      .then(({ code }) => finish(code))
      .catch(fail);
  }
}
