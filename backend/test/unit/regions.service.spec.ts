/**
 * Master-address lookups are searched case-insensitively.
 *
 * Region names are stored in title case ("Kota Bandung", "Jawa Barat") and the
 * storefront sends the customer's text verbatim (cmdk's own filter is off), so a
 * case-sensitive `contains` - PostgreSQL LIKE - returned nothing for "bandung".
 * The filter now asks Prisma for `mode: 'insensitive'` (ILIKE). Nothing is
 * normalised or written: the stored data is untouched and only the WHERE changes.
 */
import { RegionsService } from '../../src/modules/regions/regions.service';

type Delegate = { findMany: jest.Mock };

function harness() {
  const delegate = (): Delegate => ({ findMany: jest.fn().mockResolvedValue([]) });
  const prisma = { province: delegate(), city: delegate(), district: delegate(), village: delegate() };
  const service = new RegionsService(prisma as never);
  return { prisma, service };
}

type Level = 'province' | 'city' | 'district' | 'village';

const LEVELS: Array<{ level: Level; call: (s: RegionsService, q: Record<string, unknown>) => unknown; parent?: string }> = [
  { level: 'province', call: (s, q) => s.listProvinces(q) },
  { level: 'city', call: (s, q) => s.listCities({ provinceId: 'prov-32', ...q }), parent: 'provinceId' },
  { level: 'district', call: (s, q) => s.listDistricts({ cityId: 'city-3273', ...q }), parent: 'cityId' },
  { level: 'village', call: (s, q) => s.listVillages({ districtId: 'dist-327301', ...q }), parent: 'districtId' },
];

const whereOf = (d: Delegate) => d.findMany.mock.calls[0][0].where;

describe.each(LEVELS)('$level search', ({ level, call, parent }) => {
  it('is case-insensitive on the name AND the code', async () => {
    const { prisma, service } = harness();
    await call(service, { search: 'bandung' });
    expect(whereOf(prisma[level]).OR).toEqual([
      { name: { contains: 'bandung', mode: 'insensitive' } },
      { code: { contains: 'bandung', mode: 'insensitive' } },
    ]);
  });

  it('Bandung / bandung / BANDUNG / BaNdUnG produce the same filter apart from the term itself', async () => {
    const filters = [];
    for (const term of ['Bandung', 'bandung', 'BANDUNG', 'BaNdUnG']) {
      const { prisma, service } = harness();
      await call(service, { search: term });
      const where = whereOf(prisma[level]);
      filters.push(JSON.stringify(where).toLowerCase());
      expect(where.OR[0].name).toEqual({ contains: term, mode: 'insensitive' });
    }
    expect(new Set(filters).size).toBe(1);
  });

  it('trims surrounding whitespace before searching', async () => {
    const { prisma, service } = harness();
    await call(service, { search: '   Kota Bandung  ' });
    expect(whereOf(prisma[level]).OR[0].name).toEqual({ contains: 'Kota Bandung', mode: 'insensitive' });
  });

  it.each([undefined, '', '   '])('applies no name/code filter for an empty search (%p)', async (search) => {
    const { prisma, service } = harness();
    await call(service, { search });
    expect(whereOf(prisma[level])).not.toHaveProperty('OR');
  });

  it('keeps the active-only default and the parent filter', async () => {
    const { prisma, service } = harness();
    await call(service, { search: 'BANDUNG' });
    const where = whereOf(prisma[level]);
    expect(where.isActive).toBe(true);
    if (parent) expect(where[parent]).toBeDefined();
  });

  it('keeps ordering, the default limit and the selected columns', async () => {
    const { prisma, service } = harness();
    await call(service, { search: 'x' });
    const args = prisma[level].findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ name: 'asc' });
    expect(args.take).toBe(50);
    expect(args.select).toMatchObject({ id: true, code: true, name: true });
  });

  it('only READS: no write method exists on the delegate it is given', async () => {
    const { prisma, service } = harness();
    await call(service, { search: 'bandung' });
    expect(Object.keys(prisma[level])).toEqual(['findMany']);
  });
});

describe('parent filters stay exact', () => {
  it('cities are scoped to the given province id, exactly', async () => {
    const { prisma, service } = harness();
    await service.listCities({ provinceId: 'prov-32', search: 'BANDUNG' });
    expect(whereOf(prisma.city).provinceId).toBe('prov-32');
  });

  it('districts are scoped to the given city id, exactly', async () => {
    const { prisma, service } = harness();
    await service.listDistricts({ cityId: 'city-3273', search: 'coblong' });
    expect(whereOf(prisma.district).cityId).toBe('city-3273');
  });

  it('villages are scoped to the given district id, exactly', async () => {
    const { prisma, service } = harness();
    await service.listVillages({ districtId: 'dist-327301', search: 'DAGO' });
    expect(whereOf(prisma.village).districtId).toBe('dist-327301');
  });

  it('a region-code lookup still matches by code (digits are case-free)', async () => {
    const { prisma, service } = harness();
    await service.listCities({ provinceId: 'prov-32', search: '32.73' });
    expect(whereOf(prisma.city).OR).toContainEqual({ code: { contains: '32.73', mode: 'insensitive' } });
  });

  it('isActive=false is still honoured', async () => {
    const { prisma, service } = harness();
    await service.listProvinces({ isActive: false, search: 'jawa' });
    expect(whereOf(prisma.province).isActive).toBe(false);
  });
});
