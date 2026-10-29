/**
 * Migration 20261030090000_jne_one_active_matched_mapping against a real PostgreSQL.
 *
 * The partial unique index exists only in SQL (Prisma's schema language has no
 * WHERE clause), so this checks what unit tests cannot: that `migrate deploy`
 * creates it with the intended predicate, that PostgreSQL then refuses a second
 * active MATCHED row for a district while leaving every other combination alone,
 * and that Prisma's own schema diff does not propose dropping it.
 *
 * Only a PostgreSQL container - no RabbitMQ, no application services.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';

const INDEX = 'JneDistrictMapping_one_active_matched_per_district';
const BACKEND = join(__dirname, '..', '..');

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

async function seed() {
  const province = await prisma.province.create({ data: { code: '32', name: 'Jawa Barat' } });
  const city = await prisma.city.create({ data: { code: '32.04', name: 'Kabupaten Bandung', type: 'REGENCY', provinceId: province.id } });
  const district = await prisma.district.create({ data: { code: '32.04.08', name: 'Bojongsoang', cityId: city.id } });
  const loc = (code: string) =>
    prisma.jneLocation.create({
      data: { code, rawName: `X,${code}`, normalizedName: `X,${code}`, parsedChild: 'X', parsedParent: code, partCount: 2, kind: 'DESTINATION', source: 'SANDBOX', sourceFetchedAt: new Date() },
    });
  return { district, a: await loc('BDO10104'), b: await loc('BDO10199'), c: await loc('BDO10198') };
}

const mapping = (districtId: string, jneLocationId: string, status: 'MATCHED' | 'REVIEW_REQUIRED', isActive = true) =>
  prisma.jneDistrictMapping.create({ data: { districtId, jneLocationId, status, method: 'MANUAL', isActive } });

it('migrate deploy creates the index, unique, on districtId, for active MATCHED rows only', async () => {
  const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE tablename = 'JneDistrictMapping' AND indexname = ${INDEX}`;
  expect(rows).toHaveLength(1);
  expect(rows[0].indexdef).toMatch(/^CREATE UNIQUE INDEX .* USING btree \("districtId"\) WHERE \(\(status = 'MATCHED'::"JneMappingStatus"\) AND "isActive"\)$/);
});

it('a second active MATCHED row for the district is refused; every other combination is allowed', async () => {
  const { district, a, b, c } = await seed();
  await mapping(district.id, a.id, 'MATCHED');
  // Pending candidates and inactive approvals may coexist with the approved row.
  await expect(mapping(district.id, b.id, 'REVIEW_REQUIRED')).resolves.toBeDefined();
  await expect(mapping(district.id, c.id, 'MATCHED', false)).resolves.toBeDefined();
  // Promoting the pending candidate to MATCHED while the first is active: refused.
  await expect(prisma.jneDistrictMapping.updateMany({ where: { districtId: district.id, jneLocationId: b.id }, data: { status: 'MATCHED' } })).rejects.toThrow(/Unique constraint/i);
  // Re-activating the inactive approval: refused too.
  await expect(prisma.jneDistrictMapping.updateMany({ where: { districtId: district.id, jneLocationId: c.id }, data: { isActive: true } })).rejects.toThrow(/Unique constraint/i);
  // Deactivate the first, and the second may be approved: the rule is "at most one", not "frozen".
  await prisma.jneDistrictMapping.updateMany({ where: { districtId: district.id, jneLocationId: a.id }, data: { isActive: false } });
  await expect(prisma.jneDistrictMapping.updateMany({ where: { districtId: district.id, jneLocationId: b.id }, data: { status: 'MATCHED' } })).resolves.toEqual({ count: 1 });
});

it("Prisma's schema diff against the migrated database does not drop the index", () => {
  const sql = prismaCli(['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script']);
  expect(sql).not.toContain(INDEX);
  expect(sql).not.toMatch(/DROP INDEX/i);
});
