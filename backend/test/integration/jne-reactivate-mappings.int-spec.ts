/**
 * Mapping reactivation and the missing-MATCHED blocker against a real PostgreSQL: the partial
 * unique index under concurrency, a real rollback, the actual resolver, and an import that
 * leaves retired mappings alone.
 *
 * Runs only in a throwaway Testcontainers database, with synthetic rows.
 * Only a PostgreSQL container - no RabbitMQ, no application services.
 */
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

import { toCsv } from '../../prisma/tools/csv';
import { loadSnapshot, runImport, runLiveDryRun, type MasterState, type MasterStore } from '../../prisma/tools/import-jne-master';
import { planMasterImport, type MissingAcknowledgment, type TargetEnvironment } from '../../prisma/tools/jne-master-plan';
import { REVIEW_COLUMNS, runReactivations, type ReactivationStore } from '../../prisma/tools/reactivate-jne-mappings';
import { JneDestinationResolver } from '../../src/modules/shipping/infrastructure/jne-destination.resolver';

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

const store = () => prisma as unknown as ReactivationStore;
const quiet = () => {};

const loc = (code: string, rawName: string, kind: 'ORIGIN' | 'DESTINATION' = 'DESTINATION') =>
  prisma.jneLocation.create({ data: { code, rawName, normalizedName: rawName, parsedChild: rawName, parsedParent: null, partCount: 1, kind, source: 'SANDBOX', sourceFetchedAt: OLD } });

async function seed() {
  await prisma.jneDistrictMapping.deleteMany();
  await prisma.jneLocation.deleteMany();
  await prisma.district.deleteMany();
  await prisma.city.deleteMany();
  await prisma.province.deleteMany();
  const province = await prisma.province.create({ data: { code: '32', name: 'Jawa Barat' } });
  const city = await prisma.city.create({ data: { code: '32.73', name: 'Kota Bandung', type: 'CITY', provinceId: province.id } });
  const district = await prisma.district.create({ data: { code: '32.73.01', name: 'Sukasari', cityId: city.id } });
  const a = await loc('BDO10037', 'SUKASARI,BANDUNG');
  const b = await loc('BDO10054', 'COBLONG,BANDUNG');
  await loc('BDO10000', 'BANDUNG', 'ORIGIN');
  const mapping = (jneLocationId: string, isActive: boolean) =>
    prisma.jneDistrictMapping.create({ data: { districtId: district.id, jneLocationId, status: 'MATCHED', method: 'MANUAL', isActive, reviewedBy: 'first reviewer', reviewedAt: OLD } });
  return { district, a, b, mapping };
}

function review(m: { id: string; updatedAt: Date }, jne_code: string) {
  return toCsv(REVIEW_COLUMNS, [
    {
      mapping_id: m.id,
      district_code: '32.73.01',
      jne_code,
      expected_status: 'MATCHED',
      expected_is_active: 'false',
      expected_updated_at: m.updatedAt.toISOString(),
      reviewer: 'synthetic reviewer',
      reason: 'integration test reactivation',
      review_reference: 'TEST-1',
    },
  ]);
}

async function reactivate(text: string) {
  const dry = await runReactivations(store(), text, { operator: 'ops', confirm: false }, quiet);
  return runReactivations(store(), text, { operator: 'ops', confirm: true, expectCount: 1, expectPlan: dry.planSha256 }, quiet);
}

const activeMatched = (districtId: string) => prisma.jneDistrictMapping.count({ where: { districtId, status: 'MATCHED', isActive: true } });

it('restores the same row, and the actual resolver answers again', async () => {
  const { district, a, mapping } = await seed();
  const m = await mapping(a.id, false);
  const resolver = new JneDestinationResolver(prisma as never);
  await expect(resolver.resolve(district.id)).resolves.toBeNull();

  const result = await reactivate(review(m, 'BDO10037'));
  expect(result).toMatchObject({ code: 0, reactivated: 1 });

  const after = await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } });
  expect(after).toMatchObject({ id: m.id, jneLocationId: a.id, status: 'MATCHED', isActive: true, reviewedBy: 'first reviewer', reviewedAt: OLD });
  expect(after.notes).toMatch(/reactivated by ops, reviewed by synthetic reviewer \(TEST-1\): integration test reactivation; was MATCHED\/inactive, now MATCHED\/active/);
  expect(await prisma.jneDistrictMapping.count()).toBe(1);
  await expect(resolver.resolve(district.id)).resolves.toBe('BDO10037');
});

it('concurrent reactivations of two rows for one district leave exactly one active', async () => {
  const { district, a, b, mapping } = await seed();
  const first = await mapping(a.id, false);
  const second = await mapping(b.id, false);
  const firstText = review(first, 'BDO10037');
  const secondText = review(second, 'BDO10054');
  const firstDry = await runReactivations(store(), firstText, { operator: 'ops', confirm: false }, quiet);
  const secondDry = await runReactivations(store(), secondText, { operator: 'ops', confirm: false }, quiet);

  // Both runs pass every check before either transaction opens, so only the transaction
  // and the partial unique index can stop the second one.
  let arrived = 0;
  let release: () => void = () => {};
  const bothReady = new Promise<void>((resolve) => (release = resolve));
  const barrier = new Proxy(prisma, {
    get(target, prop) {
      if (prop !== '$transaction') return target[prop as keyof typeof target];
      return async (...args: unknown[]) => {
        arrived += 1;
        if (arrived === 2) release();
        await bothReady;
        return (target.$transaction as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as unknown as ReactivationStore;

  const results = await Promise.allSettled([
    runReactivations(barrier, firstText, { operator: 'ops', confirm: true, expectCount: 1, expectPlan: firstDry.planSha256 }, quiet),
    runReactivations(barrier, secondText, { operator: 'ops', confirm: true, expectCount: 1, expectPlan: secondDry.planSha256 }, quiet),
  ]);

  expect(arrived).toBe(2);
  expect(results.filter((r) => r.status === 'fulfilled' && r.value.reactivated === 1)).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await activeMatched(district.id)).toBe(1);
});

it('the database itself refuses a second active MATCHED row', async () => {
  const { a, b, mapping } = await seed();
  await mapping(a.id, true);
  const retired = await mapping(b.id, false);
  await expect(prisma.jneDistrictMapping.update({ where: { id: retired.id }, data: { isActive: true } })).rejects.toThrow(/Unique constraint/);
});

it('a failure inside the transaction leaves the row as it was', async () => {
  const { a, mapping } = await seed();
  const m = await mapping(a.id, false);
  const before = await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION rehearsal_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER rehearsal_fail BEFORE UPDATE ON "JneDistrictMapping" FOR EACH ROW EXECUTE FUNCTION rehearsal_fail()`);
  try {
    await expect(reactivate(review(m, 'BDO10037'))).rejects.toThrow(/injected failure/);
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER rehearsal_fail ON "JneDistrictMapping"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION rehearsal_fail()`);
  }
  expect(await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } })).toEqual(before);
});

// ------------------------------------------------------------------ importer

const SNAPSHOT = [{ City_Code: 'BDO10054', City_Name: 'COBLONG,BANDUNG' }];

function builder(missingAcks: MissingAcknowledgment[], requireExpectations: boolean, planSha256?: string) {
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
      reviewedRenames: [],
      missingAcks,
      target: TARGET,
      expected: { records: 1, uniqueCodes: 1, sha256, planSha256 },
      requireExpectations,
      ...state,
    });
}
const master = () => prisma as unknown as MasterStore;
const SHA = createHash('sha256').update(JSON.stringify({ detail: SNAPSHOT })).digest('hex');

it('an import leaves a retired mapping retired', async () => {
  const { district, a, mapping } = await seed();
  await loc('BDO10000', 'BANDUNG').catch(() => undefined);
  const m = await mapping(a.id, false);
  const hash = (await runLiveDryRun(master(), builder([], false), quiet)).planSha256;
  const result = await runImport(master(), builder([], true, hash), quiet);
  expect(result.code).toBe(0);
  expect(await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ isActive: false, status: 'MATCHED' });
  await expect(new JneDestinationResolver(prisma as never).resolve(district.id)).resolves.toBeNull();
});

it('a missing code under an active MATCHED mapping blocks, and an exact acknowledgment changes no mapping', async () => {
  const { district, a, mapping } = await seed();
  const m = await mapping(a.id, true);
  const mappingBefore = await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } });

  const blocked = await runLiveDryRun(master(), builder([], false), quiet);
  expect(blocked.blockers.map((b) => b.code)).toEqual(['MISSING_MATCHED_NEEDS_ACK']);

  const ack: MissingAcknowledgment = {
    mappingId: m.id,
    districtCode: '32.73.01',
    jneCode: 'BDO10037',
    expectedRawName: 'SUKASARI,BANDUNG',
    expectedStatus: 'MATCHED',
    snapshotSha256: SHA,
    reviewer: 'synthetic reviewer',
    reason: 'accepted for the integration test',
    reviewedAt: '2026-10-30T09:00:00.000Z',
  };
  const accepted = await runLiveDryRun(master(), builder([ack], false), quiet);
  expect(accepted.blockers).toEqual([]);
  expect(accepted.planSha256).not.toBe(blocked.planSha256);

  const result = await runImport(master(), builder([ack], true, accepted.planSha256), quiet);
  expect(result.code).toBe(0);
  expect(await prisma.jneDistrictMapping.findUniqueOrThrow({ where: { id: m.id } })).toEqual(mappingBefore);
  expect(await prisma.jneLocation.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ isActive: true, rawName: 'SUKASARI,BANDUNG', source: 'SANDBOX' });
  await expect(new JneDestinationResolver(prisma as never).resolve(district.id)).resolves.toBe('BDO10037');
});
