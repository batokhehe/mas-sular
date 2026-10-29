/**
 * Propose JNE destination mappings from a reviewed manifest (jne-mapping-manifest.ts).
 *
 *   npx tsx prisma/tools/import-jne-mapping-manifest.ts --manifest <file.csv> --allow-source <SOURCES> [--report <out.csv>]
 *     dry run (the default): validates every row, prints the summary, writes nothing.
 *     --allow-source (REQUIRED, no default): which JneLocation.source values a mapping
 *     may point at - PRODUCTION, SANDBOX, or SANDBOX,PRODUCTION. Accepting sandbox
 *     codes is a decision the operator states on the command line, never an omission.
 *   ... --confirm
 *     writes the ACCEPTED rows as REVIEW_REQUIRED / MANUAL candidates - only when no
 *     row was rejected, unless --allow-partial is also given. All of them or none:
 *     one serializable transaction, re-checked against the dry-run state first.
 *
 * Approval is a separate tool (approve-jne-mappings.ts). Nothing written here is
 * used at checkout until it is approved.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import type { Prisma } from '@prisma/client';
import { toCsv } from './csv';
import {
  parseManifest,
  reportRows,
  validateManifest,
  type ExistingMapping,
  type ManifestDistrict,
  type ManifestLocation,
  type ManifestReport,
} from './jne-mapping-manifest';

export const KNOWN_SOURCES = ['SANDBOX', 'PRODUCTION'] as const;
/** Rows per INSERT statement. Every chunk runs inside the ONE transaction below. */
export const WRITE_CHUNK = 500;
/** A nationwide manifest (~5,000 rows) inserts in seconds; this only bounds a stuck run. */
export const WRITE_TIMEOUT_MS = 120_000;

/** Raised when the mappings of a manifest's districts changed after validation. */
export class ManifestChangedError extends Error {}

type MappingRow = { districtId: string; jneLocationId: string; status: string; isActive: boolean; jneLocation: { code: string } };
const MAPPING_SELECT = { districtId: true, jneLocationId: true, status: true, isActive: true, jneLocation: { select: { code: true } } } as const;

/** Order-independent identity of a set of mapping rows, to detect any change. */
function fingerprint(rows: MappingRow[]): string {
  return rows
    .map((m) => `${m.districtId}|${m.jneLocationId}|${m.status}|${m.isActive}`)
    .sort()
    .join('\n');
}

export interface ImportOptions {
  manifest: string;
  report?: string;
  confirm: boolean;
  allowPartial: boolean;
  allowedSources: string[];
}

export function parseImportArgs(argv: string[]): ImportOptions {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sources = get('--allow-source');
  const allowedSources = sources ? sources.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
  const unknown = allowedSources.filter((s) => !(KNOWN_SOURCES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`--allow-source accepts ${KNOWN_SOURCES.join(', ')}; got ${unknown.join(', ')}`);
  return {
    manifest: get('--manifest') ?? '',
    report: get('--report'),
    confirm: argv.includes('--confirm'),
    allowPartial: argv.includes('--allow-partial'),
    allowedSources,
  };
}

/** The slice of PrismaClient this tool uses, so the run is testable without a database. */
export interface ImportStore {
  district: { findMany(args: unknown): Promise<ManifestDistrict[]> };
  jneLocation: { findMany(args: unknown): Promise<ManifestLocation[]> };
  jneDistrictMapping: {
    findMany(args: unknown): Promise<MappingRow[]>;
    createMany(args: { data: Prisma.JneDistrictMappingCreateManyInput[] }): Promise<{ count: number }>;
  };
  $transaction<T>(fn: (tx: ImportStore) => Promise<T>, options?: { timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

export interface ImportResult {
  code: number;
  report: ManifestReport;
  written: number;
}

export async function runImport(
  store: ImportStore,
  manifestText: string,
  opts: Pick<ImportOptions, 'confirm' | 'allowPartial' | 'allowedSources'> & { manifestId: string },
  log: (line: string) => void = console.log,
  now: () => string = () => new Date().toISOString(),
): Promise<ImportResult> {
  if (opts.allowedSources.length === 0) {
    log('--allow-source is required: state which JNE sources (PRODUCTION, SANDBOX) a mapping may point at');
    return { code: 2, report: { rows: [], accepted: 0, noop: 0, rejected: 0, byReason: {} }, written: 0 };
  }
  const entries = parseManifest(manifestText);
  const districtCodes = [...new Set(entries.map((e) => e.districtCode))];
  const jneCodes = [...new Set(entries.map((e) => e.jneCode))];

  const districts = await store.district.findMany({
    where: { code: { in: districtCodes } },
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
      city: { select: { id: true, name: true, type: true, isActive: true, province: { select: { id: true, name: true } } } },
    },
  } satisfies Prisma.DistrictFindManyArgs);
  const locations = await store.jneLocation.findMany({
    where: { code: { in: jneCodes } },
    select: { id: true, code: true, kind: true, source: true, isActive: true, rawName: true, parsedChild: true, parsedParent: true },
  } satisfies Prisma.JneLocationFindManyArgs);
  const mappingsOf = (s: ImportStore, ids: string[]) =>
    s.jneDistrictMapping.findMany({ where: { districtId: { in: ids } }, select: MAPPING_SELECT } satisfies Prisma.JneDistrictMappingFindManyArgs);
  const existing = await mappingsOf(store, districts.map((d) => d.id));

  const report = validateManifest(entries, {
    districts: new Map(districts.map((d) => [d.code, d])),
    locations,
    existing: existing.map((m): ExistingMapping => ({ ...m, jneCode: m.jneLocation.code })),
    allowedSources: opts.allowedSources,
    manifestId: opts.manifestId,
    now,
  });

  log(`manifest ${opts.manifestId}: ${entries.length} row(s)`);
  log(`  accept ${report.accepted}   no-op ${report.noop}   reject ${report.rejected}`);
  for (const [reason, n] of Object.entries(report.byReason).sort()) log(`    ${reason.padEnd(30)} ${n}`);

  if (!opts.confirm) {
    log('dry run: nothing written. Re-run with --confirm to write the accepted rows.');
    return { code: 0, report, written: 0 };
  }
  if (report.rejected > 0 && !opts.allowPartial) {
    log(`refusing to write: ${report.rejected} row(s) rejected. Fix the manifest, or pass --allow-partial to write only the accepted rows.`);
    return { code: 4, report, written: 0 };
  }

  const writes = report.rows.flatMap((r) => (r.outcome === 'ACCEPT' ? [r.write] : []));
  if (writes.length === 0) {
    log('nothing to write: every row is already pending or approved.');
    return { code: 0, report, written: 0 };
  }
  const targets = [...new Set(writes.map((w) => w.districtId))];
  const validated = fingerprint(existing.filter((m) => targets.includes(m.districtId)));

  // ONE serializable transaction for every chunk: the import either writes all of its
  // accepted rows or none. Inside it, the target districts' mappings are read again;
  // any change since validation - a candidate or approval for ANY code, which the
  // unique key alone would not catch - aborts the whole import with nothing written,
  // and Serializable makes PostgreSQL refuse a concurrent writer that slips in later.
  const written = await store.$transaction(
    async (tx) => {
      if (fingerprint(await mappingsOf(tx, targets)) !== validated) {
        throw new ManifestChangedError('mappings of the manifest districts changed since validation; nothing written - re-run the dry run');
      }
      let n = 0;
      for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
        const chunk = writes.slice(i, i + WRITE_CHUNK).map(
          (w) =>
            ({
              districtId: w.districtId,
              jneLocationId: w.jneLocationId,
              status: w.status,
              method: w.method,
              confidence: w.confidence,
              evidence: w.evidence as unknown as Prisma.InputJsonValue,
              notes: w.notes,
            }) satisfies Prisma.JneDistrictMappingCreateManyInput,
        );
        // No skipDuplicates: a duplicate fails the transaction rather than being skipped.
        n += (await tx.jneDistrictMapping.createMany({ data: chunk })).count;
      }
      return n;
    },
    { timeout: WRITE_TIMEOUT_MS, isolationLevel: 'Serializable' as Prisma.TransactionIsolationLevel },
  );
  log(`wrote ${written} REVIEW_REQUIRED candidate(s). Approve them with approve-jne-mappings.ts.`);
  return { code: 0, report, written };
}

if (require.main === module) {
  let opts: ImportOptions;
  try {
    opts = parseImportArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  if (!opts.manifest || opts.allowedSources.length === 0) {
    console.error('usage: --manifest <file.csv> --allow-source PRODUCTION|SANDBOX|SANDBOX,PRODUCTION [--report <out.csv>] [--confirm [--allow-partial]]');
    process.exit(2);
  }
  const text = readFileSync(opts.manifest, 'utf8');
  const manifestId = `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const prisma = new PrismaClient();
  runImport(prisma as unknown as ImportStore, text, { ...opts, manifestId })
    .then(({ code, report }) => {
      if (opts.report) {
        writeFileSync(opts.report, toCsv(['record', 'district_code', 'jne_code', 'confidence', 'outcome', 'reason', 'detail'], reportRows(report)));
        console.log(`report: ${opts.report}`);
      }
      return prisma.$disconnect().then(() => process.exit(code));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      return prisma.$disconnect().then(() => process.exit(1));
    });
}
