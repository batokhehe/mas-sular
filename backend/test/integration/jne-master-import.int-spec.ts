/**
 * The JNE master import against a real PostgreSQL: what an in-memory store can only
 * imitate. PostgreSQL itself refuses a write in the dry run, a failure rolls back
 * every chunk, and the mappings and location ids survive a real import.
 *
 * Runs only in a throwaway Testcontainers database, with synthetic rows.
 * Only a PostgreSQL container - no RabbitMQ, no application services.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

import { loadSnapshot, readMasterState, runDeactivateMissing, runImport, runLiveDryRun, type MasterState, type MasterStore } from '../../prisma/tools/import-jne-master';
import { locationFingerprint, planMasterImport, type TargetEnvironment } from '../../prisma/tools/jne-master-plan';
import { JneOriginBootValidator } from '../../src/modules/shipment/jne-origin-boot.validator';

const BACKEND = join(__dirname, '..', '..');
const BASE_URL = 'https://jne-production.example:10205';
const TARGET: TargetEnvironment = { jneEnvironment: 'production', jneBaseUrl: BASE_URL, jneOriginCode: 'BDO10000' };
const OLD = new Date('2026-09-02T02:40:46.000Z');
const NEW = '2026-10-30T07:50:43.065Z';

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let url: string;

const prismaCli = (args: string[]) =>
  execFileSync(join(BACKEND, 'node_modules', '.bin', 'prisma'), args, { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('app').withUsername('app').withPassword('app').start();
  url = pg.getConnectionUri();
  prismaCli(['migrate', 'deploy']);
  prisma = new PrismaClient({ datasources: { db: { url } } });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});

const store = () => prisma as unknown as MasterStore;

const loc = (code: string, rawName: string, kind: 'ORIGIN' | 'DESTINATION' = 'DESTINATION', source: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX', sourceFetchedAt = OLD) =>
  prisma.jneLocation.create({ data: { code, rawName, normalizedName: rawName, parsedChild: rawName, parsedParent: null, partCount: 1, kind, source, sourceFetchedAt } });

async function seed() {
  await prisma.jneDistrictMapping.deleteMany();
  await prisma.jneLocation.deleteMany();
  await prisma.district.deleteMany();
  await prisma.city.deleteMany();
  await prisma.province.deleteMany();
  const province = await prisma.province.create({ data: { code: '32', name: 'Jawa Barat' } });
  const city = await prisma.city.create({ data: { code: '32.73', name: 'Kota Bandung', type: 'CITY', provinceId: province.id } });
  const district = (code: string, name: string) => prisma.district.create({ data: { code, name, cityId: city.id } });
  const [d1, d2, d3] = [await district('32.73.01', 'Sukasari'), await district('32.73.02', 'Coblong'), await district('32.73.03', 'Andir')];
  // The real shape: the ORIGIN master is SANDBOX-sourced and shares codes with DESTINATION.
  const origin = await loc('BDO10000', 'BANDUNG', 'ORIGIN');
  await loc('BDO10037', 'ORIGIN NAME OF A SHARED CODE', 'ORIGIN');
  await loc('CGK10000', 'JAKARTA', 'ORIGIN');
  const same = await loc('BDO10037', 'SUKASARI,BANDUNG');
  const typo = await loc('BDO10054', 'COBLONG,BANDUG');
  await loc('BDO10132', 'ARJASARI,BANDUNG');
  await prisma.jneDistrictMapping.create({ data: { districtId: d1.id, jneLocationId: same.id, status: 'MATCHED', method: 'EXACT_NAME' } });
  await prisma.jneDistrictMapping.create({ data: { districtId: d2.id, jneLocationId: typo.id, status: 'MATCHED', method: 'REVIEWED_ALIAS' } });
  await prisma.jneDistrictMapping.create({ data: { districtId: d3.id, jneLocationId: origin.id, status: 'REVIEW_REQUIRED', method: 'MANUAL' } });
  return { same, typo };
}

const SNAPSHOT = [
  { City_Code: 'BDO10037', City_Name: 'SUKASARI,BANDUNG' },
  { City_Code: 'BDO10054', City_Name: 'COBLONG,BANDUNG' },
  { City_Code: 'TSM10000', City_Name: 'TASIKMALAYA' },
];
const REVIEW = [{ code: 'BDO10054', from: 'COBLONG,BANDUG', to: 'COBLONG,BANDUNG' }];

function builder(reviewedRenames = REVIEW, requireExpectations = true, planSha256?: string) {
  const bytes = Buffer.from(JSON.stringify({ detail: SNAPSHOT }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata = JSON.stringify({ environment: 'PRODUCTION', request: { method: 'POST', url: `${BASE_URL}/insert/getdestination` }, httpStatus: 200, bodySha256: sha256, requestStartedUtc: NEW });
  const s = loadSnapshot(bytes, metadata, 'DESTINATION', 'PRODUCTION');
  return (state: MasterState) =>
    planMasterImport({
      kind: 'DESTINATION',
      source: 'PRODUCTION',
      sha256: s.sha256,
      sourceFetchedAt: s.sourceFetchedAt,
      inspection: s.inspection,
      seeds: s.seeds,
      provenance: s.provenance,
      reviewedRenames,
      missingAcks: [],
      target: TARGET,
      expected: { records: SNAPSHOT.length, uniqueCodes: SNAPSHOT.length, sha256, planSha256 },
      requireExpectations,
      ...state,
    });
}

const quiet = () => {};
const dump = () =>
  prisma.$queryRaw`SELECT id, code, kind::text, source::text, "rawName", "isActive", "updatedAt" FROM "JneLocation" ORDER BY id`;

/** Every column, plus xmin: PostgreSQL's own record of whether a row version was rewritten. */
const originDump = () => prisma.$queryRaw`SELECT *, xmin::text AS row_version FROM "JneLocation" WHERE kind = 'ORIGIN' ORDER BY id`;
const originFingerprint = async () => locationFingerprint((await readMasterState(store())).existing.filter((e) => e.kind === 'ORIGIN'));

/** Records every row PostgreSQL writes, whichever statement or tool wrote it. */
async function recordWrites() {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS location_write_log (op text, kind text)`);
  await prisma.$executeRawUnsafe(`TRUNCATE location_write_log`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION log_location_write() RETURNS trigger AS $$
    BEGIN
      INSERT INTO location_write_log VALUES (TG_OP, COALESCE(NEW.kind, OLD.kind)::text);
      RETURN NULL;
    END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS log_location_write ON "JneLocation"`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER log_location_write AFTER INSERT OR UPDATE OR DELETE ON "JneLocation" FOR EACH ROW EXECUTE FUNCTION log_location_write()`);
}
const stopRecording = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS log_location_write ON "JneLocation"`);
const writesByKind = () => prisma.$queryRaw<Array<{ op: string; kind: string; n: number }>>`SELECT op, kind, count(*)::int AS n FROM location_write_log GROUP BY 1, 2 ORDER BY 1, 2`;

async function reviewedPlan() {
  return (await runLiveDryRun(store(), builder(REVIEW, false), quiet)).planSha256;
}

it('the dry run writes nothing, on a transaction PostgreSQL itself holds read-only', async () => {
  await seed();
  const before = await dump();
  let readOnly: unknown;
  let writeError: unknown;
  await runLiveDryRun(
    {
      ...store(),
      $transaction: ((fn: (tx: MasterStore) => Promise<unknown>, o: never) =>
        prisma.$transaction(async (tx) => {
          const wrapped = tx as unknown as MasterStore;
          const result = await fn(wrapped);
          readOnly = await tx.$queryRaw`SELECT current_setting('transaction_read_only') AS v`;
          writeError = await tx.$executeRaw`UPDATE "JneLocation" SET "isActive" = false`.catch((e: Error) => e.message);
          return result;
        }, o)) as never,
    } as MasterStore,
    builder(REVIEW, false),
    quiet,
  ).catch(() => undefined);
  expect(readOnly).toEqual([{ v: 'on' }]);
  expect(String(writeError)).toMatch(/read-only transaction/);
  expect(await dump()).toEqual(before);
});

it('imports atomically: ids and mappings survive, missing stays active, a repeat changes nothing', async () => {
  const { same, typo } = await seed();
  const mappingsBefore = await prisma.jneDistrictMapping.findMany({ orderBy: { id: 'asc' } });

  const result = await runImport(store(), builder(REVIEW, true, await reviewedPlan()), quiet);
  expect(result).toMatchObject({ code: 0, written: 3 });

  const rows = await prisma.jneLocation.findMany({ where: { kind: 'DESTINATION' }, orderBy: { code: 'asc' } });
  expect(rows.map((r) => [r.code, r.source, r.isActive])).toEqual([
    ['BDO10037', 'PRODUCTION', true],
    ['BDO10054', 'PRODUCTION', true],
    ['BDO10132', 'SANDBOX', true],
    ['TSM10000', 'PRODUCTION', true],
  ]);
  expect(rows.find((r) => r.code === 'BDO10037')!.id).toBe(same.id);
  expect(rows.find((r) => r.code === 'BDO10054')).toMatchObject({ id: typo.id, rawName: 'COBLONG,BANDUNG' });
  expect(await prisma.jneDistrictMapping.findMany({ orderBy: { id: 'asc' } })).toEqual(mappingsBefore);

  const after = await dump();
  const again = await runImport(store(), builder(REVIEW, true), quiet);
  expect(again).toMatchObject({ code: 0, written: 0 });
  expect(await dump()).toEqual(after);
});

it('a failure on the last statement leaves no row changed', async () => {
  await seed();
  const before = await dump();
  const hash = await reviewedPlan();
  // A real constraint failure, not a mock: the third step inserts a row whose id already exists.
  const failing = {
    ...store(),
    $transaction: ((fn: (tx: MasterStore) => Promise<unknown>, o: never) =>
      prisma.$transaction(async (tx) => {
        const real = tx as unknown as MasterStore;
        const wrapped = new Proxy(real, {
          get(target, prop) {
            if (prop !== 'jneLocation') return (target as never)[prop as never];
            return new Proxy(target.jneLocation, {
              get(l, m) {
                if (m !== 'updateMany') return (l as never)[m as never];
                return async (args: never) => {
                  await l.updateMany(args);
                  await tx.$executeRaw`INSERT INTO "JneLocation" (id, code, "rawName", "normalizedName", "parsedChild", "partCount", kind, source, "sourceFetchedAt", "updatedAt")
                    SELECT id, code, "rawName", "normalizedName", "parsedChild", "partCount", kind, source, "sourceFetchedAt", now() FROM "JneLocation" LIMIT 1`;
                  return { count: 0 };
                };
              },
            });
          },
        });
        return fn(wrapped);
      }, o)) as never,
  } as MasterStore;

  await expect(runImport(failing, builder(REVIEW, true, hash), quiet)).rejects.toThrow();
  expect(await dump()).toEqual(before);
});

it('a DESTINATION refresh writes only DESTINATION rows: ORIGIN is identical, row for row', async () => {
  await seed();
  const originBefore = await originDump();
  const fingerprintBefore = await originFingerprint();
  const hash = await reviewedPlan();
  await recordWrites();
  try {
    const result = await runImport(store(), builder(REVIEW, true, hash), quiet);
    expect(result).toMatchObject({ code: 0, written: 3 });
    expect(result.plan).toMatchObject({ protectedKind: 'ORIGIN', protectedFingerprint: fingerprintBefore });
    expect(await writesByKind()).toEqual([
      { op: 'INSERT', kind: 'DESTINATION', n: 1 },
      { op: 'UPDATE', kind: 'DESTINATION', n: 2 },
    ]);
  } finally {
    await stopRecording();
  }

  expect(await originDump()).toEqual(originBefore);
  expect(await originFingerprint()).toBe(fingerprintBefore);
  expect(await prisma.jneLocation.count({ where: { kind: 'ORIGIN', source: 'SANDBOX' } })).toBe(3);
  expect(await prisma.jneDistrictMapping.count({ where: { jneLocation: { kind: 'ORIGIN' } } })).toBe(1);
});

it('BDO10000 stays active and the real boot validator passes after the refresh', async () => {
  await seed();
  await runImport(store(), builder(REVIEW, true, await reviewedPlan()), quiet);
  expect(await prisma.jneLocation.findFirst({ where: { code: 'BDO10000', kind: 'ORIGIN' } })).toMatchObject({ isActive: true, source: 'SANDBOX', rawName: 'BANDUNG' });
  await expect(new JneOriginBootValidator(prisma as never).validate({ enabled: true, originCode: 'BDO10000' })).resolves.toBeUndefined();
});

it('a rollback leaves DESTINATION and ORIGIN exactly as they were', async () => {
  await seed();
  const all = await dump();
  const origins = await originDump();
  const hash = await reviewedPlan();
  await recordWrites();
  try {
    // A real failure on PostgreSQL's side, after some rows have been written.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_on_last_row() RETURNS trigger AS $$
      BEGIN
        IF NEW.code = 'BDO10054' THEN RAISE EXCEPTION 'simulated failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_on_last_row BEFORE UPDATE ON "JneLocation" FOR EACH ROW EXECUTE FUNCTION fail_on_last_row()`);
    await expect(runImport(store(), builder(REVIEW, true, hash), quiet)).rejects.toThrow(/simulated failure/);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS fail_on_last_row ON "JneLocation"`);
    await stopRecording();
  }
  expect(await writesByKind()).toEqual([]);
  expect(await dump()).toEqual(all);
  expect(await originDump()).toEqual(origins);
});

it('explicit deactivation changes only the listed code and keeps the row', async () => {
  await seed();
  await runImport(store(), builder(REVIEW, true, await reviewedPlan()), quiet);
  const result = await runDeactivateMissing(
    store(),
    builder([], true),
    { codes: ['BDO10132'], expectCount: 1, reason: 'absent from the production master', operator: 'ops', confirm: true },
    quiet,
  );
  expect(result).toMatchObject({ code: 0, written: 1 });
  expect(await prisma.jneLocation.findFirst({ where: { code: 'BDO10132' } })).toMatchObject({ isActive: false, source: 'SANDBOX' });
  expect(await prisma.jneLocation.count({ where: { kind: 'DESTINATION', isActive: true } })).toBe(3);
});
