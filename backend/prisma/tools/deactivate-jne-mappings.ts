/**
 * Deactivate JNE destination mappings, by exact district code + JNE code: the
 * rollback for an approval (or a pending candidate) that should not stand.
 *
 *   npx tsx prisma/tools/deactivate-jne-mappings.ts --pairs <file.csv> --reason "<why>" --operator "<who>"
 *     dry run (the default): shows what would be deactivated, writes nothing.
 *   ... --confirm --expect-count N
 *     sets isActive=false on exactly the listed rows, in one serializable transaction,
 *     or on none of them.
 *
 * The pairs file has two columns, district_code and jne_code - a person's explicit
 * list, never "everything in a city". A deactivated row stops resolving at once (the
 * resolver reads isActive in its WHERE clause and caches nothing), and is never
 * deleted: the row, its evidence and its reviewer stay, with the reason appended to
 * its notes. Re-activating is deliberately not offered here.
 *
 * It refuses rather than guesses: an unknown pair, a pair listed twice, a district
 * listed with two codes, a DESTINATION that is not the listed code. --expect-count
 * must equal the number of rows the dry run would change, so a pairs file that no
 * longer means what the operator reviewed fails before anything is written. Every row
 * is re-checked inside the transaction against the exact state the decision saw
 * (id, status, isActive and updatedAt); any change aborts the whole run.
 */
import { readFileSync } from 'fs';
import type { JneMappingStatus, Prisma } from '@prisma/client';
import { parseCsvRecords } from './csv';

export const PAIR_COLUMNS = ['district_code', 'jne_code'] as const;
export const REASON_MIN = 10;
export const DEACTIVATION_TIMEOUT_MS = 120_000;

export interface PairRow {
  record: number;
  districtCode: string;
  jneCode: string;
}

export function parsePairs(text: string): PairRow[] {
  return parseCsvRecords(text, PAIR_COLUMNS).records.map(({ record, values }) => ({
    record,
    districtCode: values.district_code.trim(),
    jneCode: values.jne_code.trim().toUpperCase(),
  }));
}

/** One mapping row as the decision saw it. */
export interface MappingState {
  id: string;
  districtCode: string;
  jneCode: string;
  kind: string;
  status: string;
  isActive: boolean;
  updatedAt: Date;
  notes: string | null;
}

export type DeactivationDecision =
  | { row: PairRow; outcome: 'DEACTIVATE'; mapping: MappingState }
  | { row: PairRow; outcome: 'NOOP'; reason: 'ALREADY_INACTIVE'; mapping: MappingState }
  | { row: PairRow; outcome: 'REFUSE'; reason: string };

/** Pure decision for every listed pair, given every mapping row of the listed districts. */
export function decideDeactivations(rows: PairRow[], mappings: MappingState[]): DeactivationDecision[] {
  const codesPerDistrict = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!codesPerDistrict.has(r.districtCode)) codesPerDistrict.set(r.districtCode, new Set());
    codesPerDistrict.get(r.districtCode)!.add(r.jneCode);
  }
  const seen = new Set<string>();
  return [...rows]
    .sort((a, b) => a.districtCode.localeCompare(b.districtCode) || a.record - b.record)
    .map((row): DeactivationDecision => {
      if (!/^\d{2}\.\d{2}\.\d{2}$/.test(row.districtCode) || !/^[A-Z]{3}\d{5}$/.test(row.jneCode)) {
        return { row, outcome: 'REFUSE', reason: 'malformed district_code or jne_code' };
      }
      if (codesPerDistrict.get(row.districtCode)!.size > 1) return { row, outcome: 'REFUSE', reason: 'district listed with more than one code' };
      const key = `${row.districtCode}|${row.jneCode}`;
      if (seen.has(key)) return { row, outcome: 'REFUSE', reason: 'duplicate row' };
      seen.add(key);
      const pair = mappings.filter((m) => m.districtCode === row.districtCode && m.jneCode === row.jneCode && m.kind === 'DESTINATION');
      if (pair.length === 0) return { row, outcome: 'REFUSE', reason: 'no DESTINATION mapping for this pair' };
      // (districtId, jneLocationId) is unique, and a code has one DESTINATION row, so a
      // second match means the data is not what this tool assumes.
      if (pair.length > 1) return { row, outcome: 'REFUSE', reason: 'more than one mapping row for this pair' };
      const mapping = pair[0];
      if (!mapping.isActive) return { row, outcome: 'NOOP', reason: 'ALREADY_INACTIVE', mapping };
      return { row, outcome: 'DEACTIVATE', mapping };
    });
}

export interface DeactivationStore {
  jneDistrictMapping: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        status: string;
        isActive: boolean;
        updatedAt: Date;
        notes: string | null;
        district: { code: string };
        jneLocation: { code: string; kind: string };
      }>
    >;
    updateMany(args: { where: Prisma.JneDistrictMappingWhereInput; data: Prisma.JneDistrictMappingUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: DeactivationStore) => Promise<T>, options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

export interface DeactivationOptions {
  reason: string;
  operator: string;
  confirm: boolean;
  /** Required with confirm: the number of rows the operator reviewed and expects to change. */
  expectCount?: number;
}

/** Raised inside the transaction when a row no longer matches the decision; nothing is written. */
export class MappingChangedError extends Error {}

export async function runDeactivations(
  store: DeactivationStore,
  text: string,
  opts: DeactivationOptions,
  log: (line: string) => void = console.log,
  now: () => Date = () => new Date(),
): Promise<{ code: number; decisions: DeactivationDecision[]; deactivated: number }> {
  const reason = opts.reason.trim();
  const operator = opts.operator.trim();
  if (!operator) {
    log('--operator <who> is required: a deactivation must name a person');
    return { code: 2, decisions: [], deactivated: 0 };
  }
  if (reason.length < REASON_MIN) {
    log(`--reason is required (at least ${REASON_MIN} characters): why these mappings must stop resolving`);
    return { code: 2, decisions: [], deactivated: 0 };
  }
  if (opts.confirm && (opts.expectCount === undefined || !Number.isInteger(opts.expectCount) || opts.expectCount < 1)) {
    log('--confirm requires --expect-count N (a positive integer): the number of rows the dry run showed');
    return { code: 2, decisions: [], deactivated: 0 };
  }

  const rows = parsePairs(text);
  const found = await store.jneDistrictMapping.findMany({
    where: { district: { code: { in: [...new Set(rows.map((r) => r.districtCode))] } } },
    select: {
      id: true,
      status: true,
      isActive: true,
      updatedAt: true,
      notes: true,
      district: { select: { code: true } },
      jneLocation: { select: { code: true, kind: true } },
    },
  } satisfies Prisma.JneDistrictMappingFindManyArgs);
  const decisions = decideDeactivations(
    rows,
    found.map((m) => ({
      id: m.id,
      districtCode: m.district.code,
      jneCode: m.jneLocation.code,
      kind: m.jneLocation.kind,
      status: m.status,
      isActive: m.isActive,
      updatedAt: m.updatedAt,
      notes: m.notes,
    })),
  );

  const targets = decisions.filter((d): d is Extract<DeactivationDecision, { outcome: 'DEACTIVATE' }> => d.outcome === 'DEACTIVATE');
  const refused = decisions.filter((d) => d.outcome === 'REFUSE');
  log(`deactivation by ${operator}: deactivate ${targets.length}   already inactive ${decisions.length - targets.length - refused.length}   refused ${refused.length}`);
  log(`  reason: ${reason}`);
  for (const d of decisions) {
    const detail = d.outcome === 'REFUSE' ? d.reason : d.outcome === 'NOOP' ? d.reason : `${d.mapping.status} -> inactive`;
    log(`  record ${d.row.record} ${d.row.districtCode} -> ${d.row.jneCode}: ${d.outcome} (${detail})`);
  }

  if (!opts.confirm) {
    log(`dry run: nothing written. Re-run with --confirm --expect-count ${targets.length} to deactivate.`);
    return { code: 0, decisions, deactivated: 0 };
  }
  if (refused.length > 0) {
    log('refusing to write: fix or remove the refused rows first.');
    return { code: 4, decisions, deactivated: 0 };
  }
  if (targets.length !== opts.expectCount) {
    log(`refusing to write: ${targets.length} row(s) would change, --expect-count is ${opts.expectCount}. Re-run the dry run and review.`);
    return { code: 5, decisions, deactivated: 0 };
  }

  const at = now();
  const audit = `[${at.toISOString()}] deactivated by ${operator}: ${reason}`;
  const deactivated = await store.$transaction(
    async (tx) => {
      let n = 0;
      for (const d of targets) {
        const m = d.mapping;
        // The exact state the decision saw: a row approved, rejected, re-pointed or
        // touched in any way since then (updatedAt) is not updated, and the run aborts.
        const { count } = await tx.jneDistrictMapping.updateMany({
          where: { id: m.id, status: m.status as JneMappingStatus, isActive: true, updatedAt: m.updatedAt },
          data: { isActive: false, notes: m.notes ? `${m.notes}\n${audit}` : audit },
        });
        if (count !== 1) throw new MappingChangedError(`record ${d.row.record} (${d.row.districtCode} -> ${d.row.jneCode}) changed since the dry run; nothing deactivated`);
        n += count;
      }
      if (n !== opts.expectCount) throw new MappingChangedError(`deactivated ${n}, expected ${opts.expectCount}; nothing deactivated`);
      return n;
    },
    { timeout: DEACTIVATION_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`deactivated ${deactivated} mapping(s) by ${operator}`);
  return { code: 0, decisions, deactivated };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('--pairs');
  if (!file) {
    console.error('usage: --pairs <file.csv> --reason "<why>" --operator "<who>" [--confirm --expect-count N]');
    process.exit(2);
  }
  const expect = get('--expect-count');
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  runDeactivations(prisma as unknown as DeactivationStore, readFileSync(file, 'utf8'), {
    reason: get('--reason') ?? '',
    operator: get('--operator') ?? '',
    confirm: argv.includes('--confirm'),
    expectCount: expect === undefined ? undefined : Number(expect),
  })
    .then(({ code }) => prisma.$disconnect().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      return prisma.$disconnect().then(() => process.exit(1));
    });
}
