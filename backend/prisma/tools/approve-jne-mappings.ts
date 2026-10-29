/**
 * Approve reviewed JNE destination candidates, by exact district code + JNE code.
 *
 *   npx tsx prisma/tools/approve-jne-mappings.ts --approvals <file.csv> --reviewer "<who>"
 *     dry run (the default): shows what would be promoted, writes nothing.
 *   ... --confirm
 *     promotes each listed REVIEW_REQUIRED row to MATCHED with reviewedBy/reviewedAt.
 *
 * The approvals file has two columns, district_code and jne_code: a person's
 * explicit list, not "everything pending". Only the exact pair is promoted - never
 * another pending row of the same district - and a district that is already approved
 * for a different code is refused. Writes nothing at all if any row is refused.
 */
import { readFileSync } from 'fs';
import type { Prisma } from '@prisma/client';
import { parseCsvRecords } from './csv';

export const APPROVAL_COLUMNS = ['district_code', 'jne_code'] as const;
/**
 * Two statements per approved pair run inside one transaction; Prisma's default 5 s
 * interactive-transaction timeout would roll back any batch of a few thousand.
 */
export const APPROVAL_TIMEOUT_MS = 300_000;

export interface ApprovalRow {
  record: number;
  districtCode: string;
  jneCode: string;
}

export function parseApprovals(text: string): ApprovalRow[] {
  return parseCsvRecords(text, APPROVAL_COLUMNS).records.map(({ record, values }) => ({
    record,
    districtCode: values.district_code.trim(),
    jneCode: values.jne_code.trim().toUpperCase(),
  }));
}

export interface ApprovalCandidate {
  id: string;
  districtId: string;
  districtCode: string;
  /** District AND its city active. */
  districtActive: boolean;
  jneCode: string;
  kind: string;
  locationActive: boolean;
  status: string;
  isActive: boolean;
}

export type ApprovalDecision =
  | { row: ApprovalRow; outcome: 'PROMOTE'; mappingId: string; districtId: string }
  | { row: ApprovalRow; outcome: 'NOOP'; reason: 'ALREADY_APPROVED' }
  | { row: ApprovalRow; outcome: 'REFUSE'; reason: string };

/** Pure decision for every listed pair, given every mapping row of the listed districts. */
export function decideApprovals(rows: ApprovalRow[], mappings: ApprovalCandidate[]): ApprovalDecision[] {
  const byDistrict = new Map<string, ApprovalCandidate[]>();
  for (const m of mappings) {
    if (!byDistrict.has(m.districtCode)) byDistrict.set(m.districtCode, []);
    byDistrict.get(m.districtCode)!.push(m);
  }
  const codesPerDistrict = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!codesPerDistrict.has(r.districtCode)) codesPerDistrict.set(r.districtCode, new Set());
    codesPerDistrict.get(r.districtCode)!.add(r.jneCode);
  }
  const seen = new Set<string>();

  return [...rows]
    .sort((a, b) => a.districtCode.localeCompare(b.districtCode) || a.record - b.record)
    .map((row): ApprovalDecision => {
      if (codesPerDistrict.get(row.districtCode)!.size > 1) return { row, outcome: 'REFUSE', reason: 'district listed with more than one code' };
      const key = `${row.districtCode}|${row.jneCode}`;
      if (seen.has(key)) return { row, outcome: 'REFUSE', reason: 'duplicate row' };
      seen.add(key);

      const all = byDistrict.get(row.districtCode) ?? [];
      const pair = all.filter((m) => m.jneCode === row.jneCode && m.kind === 'DESTINATION');
      if (pair.some((m) => m.status === 'MATCHED' && m.isActive)) return { row, outcome: 'NOOP', reason: 'ALREADY_APPROVED' };
      const other = all.find((m) => m.status === 'MATCHED' && m.isActive && m.jneCode !== row.jneCode);
      if (other) return { row, outcome: 'REFUSE', reason: `district already approved for ${other.jneCode}` };
      const pending = pair.find((m) => m.status === 'REVIEW_REQUIRED');
      if (!pending) return { row, outcome: 'REFUSE', reason: 'no REVIEW_REQUIRED candidate for this pair' };
      if (!pending.isActive) return { row, outcome: 'REFUSE', reason: 'the candidate is inactive' };
      if (!pending.locationActive) return { row, outcome: 'REFUSE', reason: 'the JNE location is inactive' };
      if (!pending.districtActive) return { row, outcome: 'REFUSE', reason: 'the district (or its city) is inactive' };
      return { row, outcome: 'PROMOTE', mappingId: pending.id, districtId: pending.districtId };
    });
}

export interface ApprovalStore {
  jneDistrictMapping: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        status: string;
        isActive: boolean;
        district: { id: string; code: string; isActive: boolean; city: { isActive: boolean } };
        jneLocation: { code: string; kind: string; isActive: boolean };
      }>
    >;
    count(args: { where: Prisma.JneDistrictMappingWhereInput }): Promise<number>;
    updateMany(args: { where: Prisma.JneDistrictMappingWhereInput; data: Prisma.JneDistrictMappingUpdateManyMutationInput }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ApprovalStore) => Promise<T>, options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

export async function runApprovals(
  store: ApprovalStore,
  text: string,
  opts: { reviewer: string; confirm: boolean },
  log: (line: string) => void = console.log,
  now: () => Date = () => new Date(),
): Promise<{ code: number; decisions: ApprovalDecision[]; promoted: number }> {
  if (!opts.reviewer.trim()) {
    log('--reviewer <who> is required: an approval must name a person');
    return { code: 2, decisions: [], promoted: 0 };
  }
  const rows = parseApprovals(text);
  const found = await store.jneDistrictMapping.findMany({
    where: { district: { code: { in: [...new Set(rows.map((r) => r.districtCode))] } } },
    select: {
      id: true,
      status: true,
      isActive: true,
      district: { select: { id: true, code: true, isActive: true, city: { select: { isActive: true } } } },
      jneLocation: { select: { code: true, kind: true, isActive: true } },
    },
  } satisfies Prisma.JneDistrictMappingFindManyArgs);
  const decisions = decideApprovals(
    rows,
    found.map((m) => ({
      id: m.id,
      districtId: m.district.id,
      districtCode: m.district.code,
      districtActive: m.district.isActive && m.district.city.isActive,
      jneCode: m.jneLocation.code,
      kind: m.jneLocation.kind,
      locationActive: m.jneLocation.isActive,
      status: m.status,
      isActive: m.isActive,
    })),
  );

  const promote = decisions.filter((d): d is Extract<ApprovalDecision, { outcome: 'PROMOTE' }> => d.outcome === 'PROMOTE');
  const refused = decisions.filter((d) => d.outcome === 'REFUSE');
  log(`approvals: promote ${promote.length}   already approved ${decisions.length - promote.length - refused.length}   refused ${refused.length}`);
  for (const d of refused) log(`  refused record ${d.row.record} ${d.row.districtCode} -> ${d.row.jneCode}: ${d.outcome === 'REFUSE' ? d.reason : ''}`);

  if (!opts.confirm) {
    log('dry run: nothing written. Re-run with --confirm to approve.');
    return { code: 0, decisions, promoted: 0 };
  }
  if (refused.length > 0) {
    log('refusing to write: fix or remove the refused rows first.');
    return { code: 4, decisions, promoted: 0 };
  }

  const reviewedAt = now();
  // One serializable transaction: every listed pair is approved, or none is.
  const promoted = await store.$transaction(
    async (tx) => {
      let n = 0;
      for (const d of promote) {
        const changed = () => new Error(`record ${d.row.record} (${d.row.districtCode} -> ${d.row.jneCode}) changed since the dry run; nothing approved`);
        // Another code approved for this district in the meantime: a district resolves
        // to exactly one code, so this run must not add a second.
        const others = await tx.jneDistrictMapping.count({ where: { districtId: d.districtId, status: 'MATCHED', isActive: true, NOT: { id: d.mappingId } } });
        if (others > 0) throw changed();
        // Every condition the decision checked is repeated in the WHERE clause, so a row,
        // district or JNE location changed since the dry run is simply not touched.
        const { count } = await tx.jneDistrictMapping.updateMany({
          where: {
            id: d.mappingId,
            status: 'REVIEW_REQUIRED',
            isActive: true,
            jneLocation: { kind: 'DESTINATION', isActive: true },
            district: { isActive: true, city: { isActive: true } },
          },
          data: { status: 'MATCHED', reviewedBy: opts.reviewer.trim(), reviewedAt },
        });
        if (count !== 1) throw changed();
        n += count;
      }
      return n;
    },
    { timeout: APPROVAL_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`approved ${promoted} mapping(s) as ${opts.reviewer.trim()}`);
  return { code: 0, decisions, promoted };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('--approvals');
  if (!file) {
    console.error('usage: --approvals <file.csv> --reviewer "<who>" [--confirm]');
    process.exit(2);
  }
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  runApprovals(prisma as unknown as ApprovalStore, readFileSync(file, 'utf8'), { reviewer: get('--reviewer') ?? '', confirm: argv.includes('--confirm') })
    .then(({ code }) => prisma.$disconnect().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      return prisma.$disconnect().then(() => process.exit(1));
    });
}
