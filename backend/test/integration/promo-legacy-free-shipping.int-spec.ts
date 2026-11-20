/**
 * Legacy FREE_SHIPPING courier eligibility against a real PostgreSQL.
 *
 * What unit tests (Prisma mocked) cannot show: that clearing `Promo.eligibleCouriers`
 * (a nullable Json column) with Prisma.DbNull stores SQL NULL - not the JSON literal
 * `null` - that a plain JavaScript null is refused by Prisma for this column, and that
 * the stored values drive checkout eligibility exactly as before.
 *
 * Only a throwaway PostgreSQL container (Testcontainers) with every migration applied -
 * no RabbitMQ, no application services, never a shared or production database.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { BadRequestException } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Prisma, PrismaClient } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { OrdersService } from '../../src/modules/orders/orders.service';

const BACKEND = join(__dirname, '..', '..');

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let url: string;
let admin: AdminService;
const orders = new OrdersService({} as never, {} as never, {} as never, {} as never);

const prismaCli = (args: string[]) =>
  execFileSync(join(BACKEND, 'node_modules', '.bin', 'prisma'), args, { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('app').withUsername('app').withPassword('app').start();
  url = pg.getConnectionUri();
  prismaCli(['migrate', 'deploy']);
  prisma = new PrismaClient({ datasources: { db: { url } } });
  admin = new AdminService(prisma as never, {} as never);
});

afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});

/** How the column is stored: SQL NULL vs a JSON value (jsonb 'null' would be typeof 'null'). */
async function stored(id: string) {
  const [row] = await prisma.$queryRaw<Array<{ sql_null: boolean; json_type: string | null; json_text: string | null }>>`
    SELECT "eligibleCouriers" IS NULL AS sql_null, jsonb_typeof("eligibleCouriers"::jsonb) AS json_type, "eligibleCouriers"::text AS json_text
    FROM "Promo" WHERE id = ${id}`;
  return row;
}

/** Shipping discount checkout grants with the promo as read back from PostgreSQL. */
async function shippingDiscount(id: string, courier: string) {
  const promo = await prisma.promo.findUniqueOrThrow({ where: { id } });
  return orders.calculateVoucherDiscountBreakdown(promo, 100_000, 10_000, courier).shippingDiscountAmount;
}

const legacyFreeShipping = (code: string, extra: Record<string, unknown> = {}) =>
  ({ code, title: `Gratis ongkir ${code}`, description: 'integration', voucherType: 'FREE_SHIPPING', ...extra }) as never;

let promoId: string;

it('A. create legacy FREE_SHIPPING with ["paxel"]: stored as that list; checkout allows Paxel only', async () => {
  const created = await admin.createPromo(legacyFreeShipping('ONGKIR-A', { eligibleCouriers: ['paxel'] }));
  promoId = created.id;
  expect(await stored(promoId)).toEqual({ sql_null: false, json_type: 'array', json_text: '["paxel"]' });
  expect(await shippingDiscount(promoId, 'paxel')).toBe(10_000);
  expect(await shippingDiscount(promoId, 'jne')).toBe(0);
});

it('B. update to ["paxel","jne"]: both stored and both eligible', async () => {
  await admin.updatePromo(promoId, { eligibleCouriers: ['paxel', 'jne'] } as never);
  expect(await stored(promoId)).toEqual({ sql_null: false, json_type: 'array', json_text: '["paxel", "jne"]' });
  expect(await shippingDiscount(promoId, 'paxel')).toBe(10_000);
  expect(await shippingDiscount(promoId, 'jne')).toBe(10_000);
});

it('C. switch to a percentage voucher with eligibleCouriers: null -> SQL NULL, not JSON null', async () => {
  await admin.updatePromo(promoId, { voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, eligibleCouriers: null } as never);
  expect(await stored(promoId)).toEqual({ sql_null: true, json_type: null, json_text: null });
  const promo = await prisma.promo.findUniqueOrThrow({ where: { id: promoId } });
  expect(promo.eligibleCouriers).toBeNull();
  expect(promo.voucherType).toBe('PERCENTAGE_DISCOUNT');
  // A product-only voucher: no shipping discount on any courier, product discount intact.
  expect(orders.calculateVoucherDiscountBreakdown(promo, 100_000, 10_000, 'jne')).toMatchObject({ productDiscountAmount: 10_000, shippingDiscountAmount: 0 });
});

it('C2. the inert-field rule (shipping component -> product component) also clears to SQL NULL', async () => {
  const component = await prisma.promo.create({
    data: { code: 'ONGKIR-C2', title: 'C2', description: 'x', voucherType: 'PERCENTAGE_DISCOUNT', shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] },
  });
  await admin.updatePromo(component.id, { shippingDiscountType: null, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 } as never);
  expect(await stored(component.id)).toEqual({ sql_null: true, json_type: null, json_text: null });
});

it('why the write uses Prisma.DbNull: a plain JavaScript null is stored as JSON null, DbNull as SQL NULL', async () => {
  // Plain null is outside the generated input type, and Prisma stores it as the JSON literal.
  await prisma.promo.update({ where: { id: promoId }, data: { eligibleCouriers: null as never } });
  expect(await stored(promoId)).toEqual({ sql_null: false, json_type: 'null', json_text: 'null' });
  // Both read back as null through Prisma, so checkout treats them alike ...
  expect((await prisma.promo.findUniqueOrThrow({ where: { id: promoId } })).eligibleCouriers).toBeNull();
  // ... but only DbNull is SQL NULL in the database.
  await prisma.promo.update({ where: { id: promoId }, data: { eligibleCouriers: Prisma.DbNull } });
  expect(await stored(promoId)).toEqual({ sql_null: true, json_type: null, json_text: null });
});

let legacyId: string;

it('D. existing legacy FREE_SHIPPING with SQL NULL couriers: title / active edits succeed and stay SQL NULL', async () => {
  // Fixture written directly, the way vouchers predating the rule are stored.
  const legacy = await prisma.promo.create({ data: { code: 'ONGKIR-D', title: 'Lama', description: 'x', voucherType: 'FREE_SHIPPING' } });
  legacyId = legacy.id;
  expect((await stored(legacyId)).sql_null).toBe(true);

  await admin.updatePromo(legacyId, { title: 'Judul baru' } as never);
  await admin.updatePromo(legacyId, { isActive: false } as never);
  await admin.updatePromo(legacyId, { freeShippingMaxAmount: 15_000 } as never);

  const after = await prisma.promo.findUniqueOrThrow({ where: { id: legacyId } });
  expect(after).toMatchObject({ title: 'Judul baru', isActive: false, freeShippingMaxAmount: 15_000, voucherType: 'FREE_SHIPPING' });
  expect(await stored(legacyId)).toEqual({ sql_null: true, json_type: null, json_text: null });
});

it('E. a legacy voucher with SQL NULL couriers still applies to every courier', async () => {
  await prisma.promo.update({ where: { id: legacyId }, data: { freeShippingMaxAmount: null } });
  expect(await shippingDiscount(legacyId, 'paxel')).toBe(10_000);
  expect(await shippingDiscount(legacyId, 'jne')).toBe(10_000);
});

it('F. a new FREE_SHIPPING without couriers is rejected (400) and nothing is written', async () => {
  const before = await prisma.promo.count();
  for (const extra of [{}, { eligibleCouriers: [] }, { eligibleCouriers: null }]) {
    await expect(admin.createPromo(legacyFreeShipping('ONGKIR-F', extra))).rejects.toBeInstanceOf(BadRequestException);
  }
  // Switching an existing voucher TO free shipping without couriers, or emptying a grandfathered one, too.
  await expect(admin.updatePromo(promoId, { voucherType: 'FREE_SHIPPING' } as never)).rejects.toBeInstanceOf(BadRequestException);
  await expect(admin.updatePromo(legacyId, { eligibleCouriers: [] } as never)).rejects.toBeInstanceOf(BadRequestException);
  expect(await prisma.promo.count()).toBe(before);
  expect((await prisma.promo.findUniqueOrThrow({ where: { id: promoId } })).voucherType).toBe('PERCENTAGE_DISCOUNT');
});

it('G. unsupported or duplicate couriers are rejected and nothing is written', async () => {
  const before = await prisma.promo.count();
  for (const eligibleCouriers of [['dhl'], ['paxel', 'sicepat'], ['paxel', 'paxel'], ['jne', 'JNE']]) {
    await expect(admin.createPromo(legacyFreeShipping('ONGKIR-G', { eligibleCouriers }))).rejects.toBeInstanceOf(BadRequestException);
  }
  expect(await prisma.promo.count()).toBe(before);
});
