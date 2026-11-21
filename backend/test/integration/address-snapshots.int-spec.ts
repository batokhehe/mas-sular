/**
 * Immutable address snapshots against a DISPOSABLE PostgreSQL (Testcontainers).
 *
 * 1. Migration: the database is first migrated WITHOUT 20261120090000 and seeded with
 *    "existing" rows; then the new migration is applied. Existing rows must be
 *    byte-for-byte unchanged and their new columns NULL.
 * 2. Real checkout (OrdersService + real Prisma, courier quote mocked - no network)
 *    persists Order.recipientSnapshot atomically; editing the saved Address later
 *    changes the live relation but never the snapshot.
 * 3. Shipment.destinationSnapshot round-trips; NULL snapshots stay readable.
 *
 * Self-contained: only a postgres:16-alpine container (no RabbitMQ), reaped on exit.
 */
import { execFileSync } from 'child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { PrismaClient } from '@prisma/client'
import { OrdersService } from '../../src/modules/orders/orders.service'
import { CheckoutCourier } from '../../src/modules/orders/application/dto/create-order.dto'

const BACKEND = join(__dirname, '..', '..')
const NEW_MIGRATION = '20261120090000_order_recipient_shipment_destination_snapshots'
const PRISMA_BIN = join(BACKEND, 'node_modules', '.bin', 'prisma')

let postgres: StartedPostgreSqlContainer
let url: string
let workDir: string
let prisma: PrismaClient

/** `prisma migrate deploy` from a scratch dir holding the schema + the given migrations. */
function deploy(migrations: string[]): string {
  const target = join(workDir, 'prisma', 'migrations')
  for (const name of migrations) cpSync(join(BACKEND, 'prisma', 'migrations', name), join(target, name), { recursive: true })
  return execFileSync(PRISMA_BIN, ['migrate', 'deploy', '--schema', join(workDir, 'prisma', 'schema.prisma')], {
    cwd: workDir, // no prisma.config.ts / .env here: only the throwaway DATABASE_URL below is used
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: url },
    encoding: 'utf8',
  })
}

const ids = {
  user: randomUUID(), address: randomUUID(), order: randomUUID(), shipment: randomUUID(),
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('snap').withUsername('snap').withPassword('snap').start()
  url = postgres.getConnectionUri()
  workDir = mkdtempSync(join(tmpdir(), 'snapshot-migration-'))
  cpSync(join(BACKEND, 'prisma', 'schema.prisma'), join(workDir, 'prisma', 'schema.prisma'))
  cpSync(join(BACKEND, 'prisma', 'migrations', 'migration_lock.toml'), join(workDir, 'prisma', 'migrations', 'migration_lock.toml'))
  prisma = new PrismaClient({ datasources: { db: { url } } })
}, 180_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await postgres?.stop()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** Pre-existing rows, inserted with plain SQL before the new columns exist. */
async function seedLegacyRows() {
  const now = `now()`
  await prisma.$executeRawUnsafe(`INSERT INTO "User" (id, email, name, "updatedAt") VALUES ('${ids.user}', 'legacy-${ids.user}@test.local', 'Legacy', ${now})`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Address" (id, "userId", label, "recipientName", phone, "fullAddress", latitude, longitude, "updatedAt")
     VALUES ('${ids.address}', '${ids.user}', 'Rumah', 'Legacy Recipient', '0811', 'Jl. Lama 1', 0, 0, ${now})`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Order" (id, "orderNumber", "userId", "addressId", subtotal, "deliveryFee", "totalPrice", "paymentMethod", "trackingNumber", "updatedAt")
     VALUES ('${ids.order}', 'BMS-LEGACY-${ids.order.slice(0, 8)}', '${ids.user}', '${ids.address}', 30000, 10000, 40000, 'BANK_TRANSFER', '0291492600000050', ${now})`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Shipment" (id, "orderId", provider, service, cost, "trackingNumber", "providerPayload", "updatedAt")
     VALUES ('${ids.shipment}', '${ids.order}', 'jne', 'REG', 10000, '0291492600000050', '{"detail":[{"status":"success"}]}', ${now})`,
  )
}

async function rowJson(table: 'Order' | 'Shipment', id: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ j: Record<string, unknown> }>>(`SELECT row_to_json(t) AS j FROM "${table}" t WHERE id = '${id}'`)
  return rows[0].j
}

describe('Address snapshot migration (disposable PostgreSQL)', () => {
  let orderBefore: Record<string, unknown>
  let shipmentBefore: Record<string, unknown>

  it('applies additively: existing rows unchanged, new columns NULL, nullable JSONB', async () => {
    const previous = readdirSync(join(BACKEND, 'prisma', 'migrations')).filter((n) => n !== 'migration_lock.toml' && n !== NEW_MIGRATION).sort()
    deploy(previous)
    await seedLegacyRows()
    orderBefore = await rowJson('Order', ids.order)
    shipmentBefore = await rowJson('Shipment', ids.shipment)
    expect(orderBefore).not.toHaveProperty('recipientSnapshot')

    const out = deploy([NEW_MIGRATION])
    expect(out).toMatch(/1 migration|Applying migration `20261120090000/)

    const orderAfter = await rowJson('Order', ids.order)
    const shipmentAfter = await rowJson('Shipment', ids.shipment)
    const { recipientSnapshot, ...orderRest } = orderAfter
    const { destinationSnapshot, ...shipmentRest } = shipmentAfter
    expect(recipientSnapshot).toBeNull()
    expect(destinationSnapshot).toBeNull()
    expect(orderRest).toEqual(orderBefore)
    expect(shipmentRest).toEqual(shipmentBefore)

    const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null }>>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE (table_name = 'Order' AND column_name = 'recipientSnapshot') OR (table_name = 'Shipment' AND column_name = 'destinationSnapshot')
       ORDER BY table_name`,
    )
    expect(columns).toEqual([
      { table_name: 'Order', column_name: 'recipientSnapshot', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
      { table_name: 'Shipment', column_name: 'destinationSnapshot', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
    ])
    // Re-running deploy is a no-op.
    expect(deploy([])).toMatch(/No pending migrations/)
  }, 180_000)

  it('legacy rows with NULL snapshots stay readable through Prisma', async () => {
    const order = await prisma.order.findUnique({ where: { id: ids.order }, include: { address: true, shipment: true } })
    expect(order?.recipientSnapshot).toBeNull()
    expect(order?.shipment?.destinationSnapshot).toBeNull()
    expect(order?.address.recipientName).toBe('Legacy Recipient')
  })
})

describe('Checkout recipient snapshot (real Prisma transaction)', () => {
  async function seedCheckout() {
    const uid = randomUUID().slice(0, 8)
    const province = await prisma.province.create({ data: { code: `P${uid}`, name: 'Jawa Barat' } })
    const city = await prisma.city.create({ data: { code: `C${uid}`, name: 'Kabupaten Bandung', provinceId: province.id, type: 'REGENCY' } })
    const district = await prisma.district.create({ data: { code: `D${uid}`, name: 'Bojongsoang', cityId: city.id } })
    const village = await prisma.village.create({ data: { code: `V${uid}`, name: 'Lengkong', districtId: district.id } })
    await prisma.outlet.create({ data: { name: `Outlet ${uid}`, postalCode: '40111', latitude: -6.9, longitude: 107.6, isActive: true } })
    const category = await prisma.category.create({ data: { name: `Cat ${uid}`, slug: `cat-${uid}` } })
    const product = await prisma.product.create({
      data: { slug: `p-${uid}`, sku: `sku-${uid}`, name: 'Bakso', description: 'x', price: 30000, imageUrl: '/x.png', stock: 10, categoryId: category.id, weightGram: 450 },
    })
    const user = await prisma.user.create({ data: { email: `u-${uid}@test.local`, name: 'Siti' } })
    const address = await prisma.address.create({
      data: {
        userId: user.id, label: 'Rumah', recipientName: 'Siti Aminah', phone: '081234567890',
        fullAddress: 'Jl. Melati No. 5, Bojongsoang', addressDetail: 'Jl. Melati No. 5 RT 02/RW 03', notes: 'Pagar hijau',
        latitude: -6.97, longitude: 107.63, provinceId: province.id, cityId: city.id, districtId: district.id, villageId: village.id, postalCode: '40287',
      },
    })
    return { user, address, product, city }
  }

  function service() {
    const shipping = { calculateRateForCourier: jest.fn().mockResolvedValue({ cost: 10000, etd: '2 days' }) }
    const idempotency = { isCheckoutEnabled: () => false }
    const uploadTokens = { issue: jest.fn() }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new OrdersService(prisma as any, shipping as any, idempotency as any, uploadTokens as any)
  }

  it('persists the snapshot with the order; a later Address edit does not change it; region names survive master-data edits', async () => {
    const { user, address, product, city } = await seedCheckout()
    const outcome = await service().checkout(user.id, { address_id: address.id, courier: CheckoutCourier.JNE, items: [{ product_id: product.id, qty: 1 }] })
    if (outcome.kind !== 'result') throw new Error(`unexpected checkout outcome ${outcome.kind}`)
    const body = outcome.body as { id: string }
    const orderId = body.id
    // Customer response shape is unchanged.
    expect(body).not.toHaveProperty('recipientSnapshot')

    const expected = {
      version: 1, recipientName: 'Siti Aminah', phone: '081234567890', addressDetail: 'Jl. Melati No. 5 RT 02/RW 03',
      fullAddress: 'Jl. Melati No. 5, Bojongsoang', village: 'Lengkong', district: 'Bojongsoang', city: 'Kabupaten Bandung',
      province: 'Jawa Barat', postalCode: '40287', note: 'Pagar hijau',
    }
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.recipientSnapshot).toEqual(expected)

    // The customer edits the saved address (as PATCH /me/addresses/:id does: update in place),
    // and region master data is renamed.
    await prisma.address.update({ where: { id: address.id }, data: { recipientName: 'Nama Baru', addressDetail: 'Alamat baru', phone: '089999', postalCode: '40000' } })
    await prisma.city.update({ where: { id: city.id }, data: { name: 'Kab. Bandung (baru)' } })

    const reloaded = await prisma.order.findUnique({ where: { id: orderId }, include: { address: { include: { city: true } } } })
    expect(reloaded?.address.recipientName).toBe('Nama Baru') // the live relation moved...
    expect(reloaded?.address.city?.name).toBe('Kab. Bandung (baru)')
    expect(reloaded?.recipientSnapshot).toEqual(expected) // ...the snapshot did not
    expect(reloaded?.addressId).toBe(address.id) // relation preserved
  }, 60_000)

  it('atomic: a failure INSIDE the order-create transaction leaves no order, no snapshot and no stock change', async () => {
    const { user, address, product } = await seedCheckout()
    // Disposable DB only: make the nested OrderItem insert of order.create fail, i.e.
    // after the Order row (with its snapshot) was written inside the same transaction.
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION snapshot_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER snapshot_test_fail BEFORE INSERT ON "OrderItem" FOR EACH ROW EXECUTE FUNCTION snapshot_test_fail()`)
    try {
      await expect(
        service().checkout(user.id, { address_id: address.id, courier: CheckoutCourier.JNE, items: [{ product_id: product.id, qty: 1 }] }),
      ).rejects.toThrow(/forced failure/)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER snapshot_test_fail ON "OrderItem"`)
    }
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0)
    expect((await prisma.product.findUnique({ where: { id: product.id } }))?.stock).toBe(10)
  }, 60_000)
})

describe('Shipment destination snapshot column', () => {
  it('stores and returns the versioned snapshot; NULL stays supported', async () => {
    const snapshot = {
      version: 1, provider: 'jne', capturedAt: '2026-11-20T00:00:00.000Z', recipientName: 'Siti Aminah', phone: '081234567890',
      addressLines: ['Jl. Melati No. 5 RT 02/RW 03, ', 'Kel. Lengkong, Kec. Bojongsoan'], village: null, district: null,
      city: 'Kabupaten Bandung', province: 'Jawa Barat', postalCode: '40287', note: null, addressTruncated: true,
      providerFields: { RECEIVER_NAME: 'Siti Aminah', RECEIVER_ADDR1: 'Jl. Melati No. 5 RT 02/RW 03, ' },
    }
    await prisma.shipment.update({ where: { id: ids.shipment }, data: { destinationSnapshot: snapshot } })
    expect((await prisma.shipment.findUnique({ where: { id: ids.shipment } }))?.destinationSnapshot).toEqual(snapshot)
    // The AWB and the other columns are untouched by writing the snapshot.
    expect((await prisma.shipment.findUnique({ where: { id: ids.shipment } }))?.trackingNumber).toBe('0291492600000050')
  })
})
