/**
 * PostgreSQL type-fidelity + transaction proof (migration step 6).
 *
 *   DATABASE_URL=postgresql://... npx tsx prisma/tools/pg-types-verify.ts
 *
 * Proves the data types that behave DIFFERENTLY between MySQL and PostgreSQL
 * still round-trip correctly through Prisma: native enums, Decimal precision,
 * DateTime, real Boolean (not TINYINT), Json (jsonb), plus CRUD, transaction
 * rollback, and the CHECK constraints that replaced @db.UnsignedInt.
 *
 * Disposable databases only. Every row it writes is rolled back or deleted.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(ql)?:\/\//.test(url) || !/localhost|127\.0\.0\.1/.test(url)) {
  console.error('refusing to run: DATABASE_URL must be a LOCAL postgresql:// URL');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const results: Array<[string, boolean, string]> = [];
async function t(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push([name, true, note ?? '']);
  } catch (e) {
    results.push([name, false, e instanceof Error ? e.message.split('\n').filter((l) => l.trim()).slice(-2).join(' | ') : String(e)]);
  }
}
const eq = (a: unknown, b: unknown, what: string) => {
  if (String(a) !== String(b)) throw new Error(`${what}: expected ${String(b)}, got ${String(a)}`);
};

async function main() {
  const uid = randomUUID().slice(0, 8);
  const cat = await prisma.category.create({ data: { name: `t-${uid}`, slug: `t-${uid}` } });

  // ------------------------------------------------------------------- CRUD
  let productId = '';
  await t('CRUD create/read/update/delete on Product', async () => {
    const p = await prisma.product.create({
      data: { slug: `p-${uid}`, sku: `SKU-${uid}`, name: 'P', description: 'd', price: 1000, imageUrl: '/i.png', categoryId: cat.id, stock: 5 },
    });
    productId = p.id;
    const read = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    eq(read.name, 'P', 'read name');
    const upd = await prisma.product.update({ where: { id: p.id }, data: { name: 'P2' } });
    eq(upd.name, 'P2', 'updated name');
    return 'create/read/update ok';
  });

  // ------------------------------------------------------------------ ENUMS
  await t('ENUM native type round-trips (ProductStatus)', async () => {
    const p = await prisma.product.update({ where: { id: productId }, data: { status: 'ARCHIVED' } });
    eq(p.status, 'ARCHIVED', 'enum value');
    const back = await prisma.product.findFirst({ where: { status: 'ARCHIVED', id: productId } });
    if (!back) throw new Error('enum filter returned no row');
    await prisma.product.update({ where: { id: productId }, data: { status: 'ACTIVE' } });
    return 'ProductStatus ARCHIVED round-trip + filter ok';
  });
  await t('ENUM rejects a value outside the type', async () => {
    try {
      await prisma.$executeRawUnsafe(`UPDATE "Product" SET status = 'NOT_A_STATUS'::"ProductStatus" WHERE id = $1`, productId);
    } catch {
      return 'invalid enum literal correctly rejected';
    }
    throw new Error('an invalid enum value was accepted');
  });

  // ---------------------------------------------------------------- DECIMAL
  await t('DECIMAL(3,2) precision preserved (Product.rating)', async () => {
    const p = await prisma.product.update({ where: { id: productId }, data: { rating: new Prisma.Decimal('4.35') } });
    eq(p.rating.toString(), '4.35', 'rating');
    return 'rating 4.35 exact';
  });
  await t('DECIMAL(10,7) precision preserved (Address.latitude)', async () => {
    const u = await prisma.user.create({ data: { email: `u-${uid}@t.local`, name: 'U' } });
    const a = await prisma.address.create({
      data: { userId: u.id, label: 'H', recipientName: 'R', phone: '6281200000000', fullAddress: 'X', latitude: new Prisma.Decimal('-6.9174639'), longitude: new Prisma.Decimal('107.6191228') },
    });
    eq(a.latitude?.toString(), '-6.9174639', 'latitude');
    eq(a.longitude?.toString(), '107.6191228', 'longitude');
    return '7 decimal places exact';
  });

  // --------------------------------------------------------------- DATETIME
  await t('DATETIME round-trips to the millisecond', async () => {
    const when = new Date('2026-03-04T05:06:07.089Z');
    const row = await prisma.systemLog.create({ data: { module: 'test', action: 'dt', level: 'INFO', message: 'm', createdAt: when } });
    const back = await prisma.systemLog.findUniqueOrThrow({ where: { id: row.id } });
    eq(back.createdAt.toISOString(), when.toISOString(), 'createdAt');
    await prisma.systemLog.delete({ where: { id: row.id } });
    return when.toISOString();
  });

  // ---------------------------------------------------------------- BOOLEAN
  await t('BOOLEAN is a real bool (not TINYINT)', async () => {
    const p = await prisma.product.update({ where: { id: productId }, data: { isBestSeller: true, isNew: false } });
    if (p.isBestSeller !== true || p.isNew !== false) throw new Error('boolean values did not round-trip');
    const typ = (await prisma.$queryRawUnsafe(
      `SELECT data_type FROM information_schema.columns WHERE table_name='Product' AND column_name='isBestSeller'`,
    )) as Array<{ data_type: string }>;
    eq(typ[0]?.data_type, 'boolean', 'column type');
    return 'data_type=boolean, true/false round-trip ok';
  });

  // ------------------------------------------------------------------- JSON
  await t('JSON stored as jsonb and queryable by path', async () => {
    const payload = { orderId: `o-${uid}`, nested: { n: 1 }, list: [1, 2, 3] };
    const row = await prisma.notificationOutbox.create({
      data: { channel: 'EMAIL', template: 'x', recipient: 'a@b.c', payload, status: 'PENDING', nextAttemptAt: new Date() },
    });
    const back = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    eq(JSON.stringify((back.payload as Record<string, unknown>).nested), '{"n":1}', 'nested json');
    const found = await prisma.notificationOutbox.findFirst({ where: { payload: { path: ['orderId'], equals: `o-${uid}` } } });
    if (!found) throw new Error('json path filter returned no row');
    const typ = (await prisma.$queryRawUnsafe(
      `SELECT data_type FROM information_schema.columns WHERE table_name='NotificationOutbox' AND column_name='payload'`,
    )) as Array<{ data_type: string }>;
    eq(typ[0]?.data_type, 'jsonb', 'column type');
    await prisma.notificationOutbox.delete({ where: { id: row.id } });
    return 'data_type=jsonb, path filter ok';
  });

  // ------------------------------------------------------------ TRANSACTION
  await t('TRANSACTION rolls back every write on throw', async () => {
    const before = await prisma.product.count();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.product.create({ data: { slug: `rb-${uid}`, sku: `RB-${uid}`, name: 'RB', description: 'd', price: 1, imageUrl: '/i.png', categoryId: cat.id } });
        throw new Error('deliberate rollback');
      });
    } catch {
      /* expected */
    }
    const after = await prisma.product.count();
    eq(after, before, 'product count after rollback');
    const orphan = await prisma.product.findUnique({ where: { slug: `rb-${uid}` } });
    if (orphan) throw new Error('rolled-back row is still present');
    return `count stable at ${after}`;
  });

  await t('TRANSACTION commits all writes on success', async () => {
    const res = await prisma.$transaction(async (tx) => {
      const c = await tx.category.create({ data: { name: `tx-${uid}`, slug: `tx-${uid}` } });
      await tx.product.create({ data: { slug: `tx-${uid}`, sku: `TX-${uid}`, name: 'TX', description: 'd', price: 1, imageUrl: '/i.png', categoryId: c.id } });
      return c.id;
    });
    const p = await prisma.product.findUnique({ where: { slug: `tx-${uid}` } });
    if (!p) throw new Error('committed row missing');
    await prisma.product.delete({ where: { slug: `tx-${uid}` } });
    await prisma.category.delete({ where: { id: res } });
    return 'commit visible after tx';
  });

  // ------------------------------------------- CHECK constraints (ex-UnsignedInt)
  await t('CHECK constraint rejects a negative value (replaces @db.UnsignedInt)', async () => {
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "OutboxEvent" (id,"aggregateType","aggregateId","eventName",exchange,"routingKey",payload,status,attempts,"maxAttempts","nextAttemptAt","occurredAt","createdAt")
         VALUES ($1,'x','x','x','x','x','{}','PENDING',-1,10,now(),now(),now())`,
        `neg-${uid}`,
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : '';
      if (!/nonneg|check constraint/i.test(m)) throw new Error('rejected, but not by the CHECK constraint: ' + m.slice(0, 120));
      return 'attempts = -1 rejected by OutboxEvent_attempts_nonneg';
    }
    throw new Error('a negative attempts value was accepted');
  });
  await t('CHECK constraint still allows NULL on nullable columns', async () => {
    const p = await prisma.promo.create({
      data: { code: `C-${uid}`, title: 't', description: 'd', voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: null, maxUsageCount: null },
    });
    if (p.discountPercentage !== null || p.maxUsageCount !== null) throw new Error('null was not preserved');
    await prisma.promo.delete({ where: { id: p.id } });
    return 'NULL accepted on nullable ex-unsigned columns';
  });

  // ------------------------------------------------------- nullable SKU (#5)
  await t('SKU is nullable and still unique across non-null values', async () => {
    const a = await prisma.product.create({ data: { slug: `n1-${uid}`, sku: null, name: 'N1', description: 'd', price: 1, imageUrl: '/i.png', categoryId: cat.id } });
    const b = await prisma.product.create({ data: { slug: `n2-${uid}`, sku: null, name: 'N2', description: 'd', price: 1, imageUrl: '/i.png', categoryId: cat.id } });
    let duplicateRejected = false;
    try {
      await prisma.product.create({ data: { slug: `n3-${uid}`, sku: `SKU-${uid}`, name: 'N3', description: 'd', price: 1, imageUrl: '/i.png', categoryId: cat.id } });
    } catch {
      duplicateRejected = true;
    }
    await prisma.product.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    if (!duplicateRejected) throw new Error('a duplicate non-null sku was accepted');
    return 'two NULL skus allowed; duplicate non-null sku rejected';
  });

  // --------------------------------------------------------------- teardown
  await prisma.product.deleteMany({ where: { categoryId: cat.id } });
  await prisma.address.deleteMany({ where: { user: { email: `u-${uid}@t.local` } } });
  await prisma.user.deleteMany({ where: { email: `u-${uid}@t.local` } });
  await prisma.category.delete({ where: { id: cat.id } });

  console.log('');
  let pass = 0, fail = 0;
  for (const [n, ok, note] of results) {
    console.log((ok ? 'PASS ' : 'FAIL ') + n + (note ? '\n       ' + note : ''));
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('harness crashed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
