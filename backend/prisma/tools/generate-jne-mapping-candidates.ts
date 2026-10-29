/**
 * PAXELBOX-61F: show the JNE mapping candidates the name resolver finds for one city.
 * READ-ONLY.
 *
 *   npx tsx prisma/tools/generate-jne-mapping-candidates.ts --city "Kota Bandung"
 *
 * ---------------------------------------------------------------------------
 * THIS TOOL NO LONGER WRITES
 *
 * It used to upsert candidates (`--generate`, rewriting method/evidence/notes even on
 * approved rows) and to approve them (`--approve`: every REVIEW_REQUIRED row of a
 * district, outside a transaction, without re-checking the JNE location or the
 * district). Both paths bypassed the safeguards of the manifest tools, so both are
 * gone. A database write now goes through exactly two tools:
 *
 *   import-jne-mapping-manifest.ts   propose candidates (dry run by default)
 *   approve-jne-mappings.ts          approve explicit pairs (dry run by default)
 *
 * The write flags are REFUSED, before any database access, rather than ignored, so a
 * runbook that still says `--approve` fails loudly instead of appearing to work.
 * The store this tool receives has no write method at all.
 */

import { resolveDistrictCandidates, type InternalDistrict, type JneCandidateRow, type MappingCandidate } from './jne-district-mapping';

export interface CliOptions {
  city: string;
}

/** Flags of the retired write paths. Any of them refuses the run. */
export const RETIRED_FLAGS = ['--approve', '--reviewer', '--confirm', '--write', '--generate'] as const;

export const RETIRED_MESSAGE =
  'this tool is read-only: --generate/--approve no longer write. Propose candidates with ' +
  'import-jne-mapping-manifest.ts and approve explicit pairs with approve-jne-mappings.ts.';

export function parseArgs(argv: string[]): CliOptions | { refused: string } {
  const retired = argv.filter((a) => (RETIRED_FLAGS as readonly string[]).includes(a));
  if (retired.length > 0) return { refused: `${retired.join(', ')}: ${RETIRED_MESSAGE}` };
  const i = argv.indexOf('--city');
  return { city: i >= 0 ? (argv[i + 1] ?? '') : 'Kota Bandung' };
}

export function formatCandidates(candidates: MappingCandidate[]): string {
  const lines = ['district              status           method           jne code   jne raw name'];
  for (const c of candidates) {
    lines.push(
      c.district.name.padEnd(22) +
        c.status.padEnd(17) +
        c.method.padEnd(17) +
        (c.evidence.jneCode ?? '—').padEnd(11) +
        (c.evidence.jneRawName ?? '—'),
    );
  }
  return lines.join('\n');
}

/** The only database access this tool has: two reads. */
export interface CandidateReadStore {
  district: { findMany(args: unknown): Promise<unknown[]> };
  jneLocation: { findMany(args: unknown): Promise<unknown[]> };
}

export async function main(argv: string[], store: () => CandidateReadStore, log: (line: string) => void = console.log): Promise<number> {
  const opts = parseArgs(argv);
  if ('refused' in opts) {
    log(opts.refused);
    return 2;
  }
  if (!opts.city) {
    log('usage: --city "<city name>"');
    return 2;
  }
  const db = store();

  const districts = (await db.district.findMany({
    where: { city: { name: opts.city } },
    select: {
      id: true,
      name: true,
      city: { select: { id: true, name: true, type: true, province: { select: { id: true, name: true } } } },
    },
    orderBy: { code: 'asc' },
  })) as Array<{
    id: string;
    name: string;
    city: { id: string; name: string; type: string; province: { id: string; name: string } };
  }>;
  if (districts.length === 0) {
    log(`no districts found for city "${opts.city}"`);
    return 3;
  }
  const internal: InternalDistrict[] = districts.map((d) => ({
    id: d.id,
    name: d.name,
    cityId: d.city.id,
    cityName: d.city.name,
    cityType: d.city.type as 'CITY' | 'REGENCY',
    provinceId: d.city.province.id,
    provinceName: d.city.province.name,
  }));

  const rows = (await db.jneLocation.findMany({
    where: { kind: 'DESTINATION', source: 'SANDBOX', isActive: true },
    select: { id: true, code: true, rawName: true, parsedChild: true, parsedParent: true, kind: true, source: true, isActive: true },
  })) as JneCandidateRow[];
  const summary = resolveDistrictCandidates(internal, rows);

  log(`city: ${opts.city}`);
  log(`internal districts: ${summary.districts}   JNE candidate pool: ${rows.length}`);
  log(`REVIEW_REQUIRED=${summary.reviewRequired} AMBIGUOUS=${summary.ambiguous} NOT_FOUND=${summary.notFound} MATCHED=${summary.matched}`);
  log(`EXACT_NAME=${summary.exactName} REVIEWED_ALIAS=${summary.reviewedAlias}\n`);
  log(formatCandidates(summary.candidates));
  log('\nread-only: nothing was written. Propose with import-jne-mapping-manifest.ts, approve with approve-jne-mappings.ts.');
  return 0;
}

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  let prisma: InstanceType<typeof PrismaClient> | undefined;
  main(process.argv.slice(2), () => (prisma = new PrismaClient()) as unknown as CandidateReadStore)
    .then(async (code) => {
      await prisma?.$disconnect();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      await prisma?.$disconnect();
      process.exit(1);
    });
}
