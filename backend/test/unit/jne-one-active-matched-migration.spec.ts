/**
 * The one-active-MATCHED-per-district index lives only in SQL: Prisma's schema
 * language cannot express its WHERE clause. These checks run in the normal unit
 * suite (and so in CI) without a database; the PostgreSQL behaviour itself is
 * covered by test/integration/jne-one-active-matched.int-spec.ts.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { JneDestinationResolver } from '../../src/modules/shipping/infrastructure/jne-destination.resolver';

const MIGRATIONS = join(__dirname, '..', '..', 'prisma', 'migrations');
const NAME = '20261030090000_jne_one_active_matched_mapping';
const INDEX = 'JneDistrictMapping_one_active_matched_per_district';

const sqlOf = (dir: string) => readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
const migrations = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const code = (sql: string) => sql.replace(/--.*$/gm, '');

describe(`migration ${NAME}`, () => {
  it('creates the partial unique index on districtId for active MATCHED rows', () => {
    expect(migrations).toContain(NAME);
    expect(code(sqlOf(NAME)).replace(/\s+/g, ' ').trim()).toBe(
      `CREATE UNIQUE INDEX "${INDEX}" ON "JneDistrictMapping" ("districtId") WHERE "status" = 'MATCHED' AND "isActive";`,
    );
  });

  it('no migration drops, renames or recreates the index (a `prisma migrate dev` that proposes it must be edited)', () => {
    const offenders = migrations.filter((m) => m !== NAME && new RegExp(`(DROP|ALTER)\\s+INDEX[^;]*${INDEX}|${INDEX}`, 'i').test(code(sqlOf(m))));
    expect(offenders).toEqual([]);
  });

  it('runs after every migration that creates JneDistrictMapping', () => {
    const creator = migrations.find((m) => /CREATE TABLE "JneDistrictMapping"/.test(sqlOf(m)));
    expect(creator).toBeDefined();
    expect(migrations.indexOf(NAME)).toBeGreaterThan(migrations.indexOf(creator!));
  });
});

describe('the resolver reads in a deterministic order', () => {
  it('earliest approval first, then id - never planner order', async () => {
    const findFirst = jest.fn(async () => ({ jneLocation: { code: 'BDO10104' } }));
    const resolver = new JneDestinationResolver({ jneDistrictMapping: { findFirst } } as never);
    await expect(resolver.resolve('dist-1')).resolves.toBe('BDO10104');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { districtId: 'dist-1', isActive: true, status: 'MATCHED', jneLocation: { kind: 'DESTINATION', isActive: true } },
        orderBy: [{ reviewedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      }),
    );
  });
});
