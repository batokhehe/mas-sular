/**
 * Duplicate courier booking recovery against a DISPOSABLE PostgreSQL (Testcontainers).
 * The unit spec (test/unit/shipment-booking-recovery.spec.ts) covers every path with
 * an in-memory double; this one proves the parts only the real database can:
 *
 * 1. Migration 20261121090000 is additive: rows that existed before it are unchanged
 *    and their new columns are NULL; a legacy stale PENDING row is still reclaimed.
 * 2. The booking claim is atomic under real concurrency: many simultaneous callers
 *    against one shipment -> exactly one owner token, exactly one courier call.
 * 3. A stale attempt that comes back after the shipment was parked, reconciled and
 *    re-claimed hits Prisma's real P2025 on its ownership compare-and-set and changes
 *    nothing on the newer attempt's row.
 * 4. not_booked consults the real IntegrationApiLog and refuses while the courier is
 *    on record as having accepted a booking.
 * 5. The generic admin PATCH / DELETE cannot resolve, reset or remove a shipment in
 *    recovery or in flight, while ordinary edits (compare-and-set writes) still apply.
 *
 * Real ShipmentService + real Prisma; the courier is a mock (no network, no real
 * booking). Self-contained: only a postgres:16-alpine container, reaped on exit.
 */
import { execFileSync } from 'child_process'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { OrderStatus, PrismaClient, ShipmentStatus } from '@prisma/client'
import { BOOKING_IN_PROGRESS, RECONCILIATION_REQUIRED, ShipmentService } from '../../src/modules/shipment/shipment.service'
import { AdminService } from '../../src/modules/admin/admin.service'

const BACKEND = join(__dirname, '..', '..')
const NEW_MIGRATION = '20261121090000_shipment_booking_attempt_owner'
const PRISMA_BIN = join(BACKEND, 'node_modules', '.bin', 'prisma')
const LEASE_MS = 5 * 60 * 1000
const EVIDENCE = { confirmNoActiveBooking: true, courierCheckReference: 'JNE CS ticket 48213' } as const

let postgres: StartedPostgreSqlContainer
let url: string
let workDir: string
let prisma: PrismaClient

function deploy(migrations: string[]): string {
  const target = join(workDir, 'prisma', 'migrations')
  for (const name of migrations) cpSync(join(BACKEND, 'prisma', 'migrations', name), join(target, name), { recursive: true })
  return execFileSync(PRISMA_BIN, ['migrate', 'deploy', '--schema', join(workDir, 'prisma', 'schema.prisma')], {
    cwd: workDir, // no prisma.config.ts / .env here: only the throwaway DATABASE_URL below is used
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: url },
    encoding: 'utf8',
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

const booked = (awb: string) => ({ trackingNumber: awb, providerShipmentId: awb, status: ShipmentStatus.CREATED, rawPayload: { cnote: awb } })

function courier() {
  const provider = { name: 'jne', supportsAutomaticBooking: true, requiresPickupSchedule: false, createShipment: jest.fn() }
  const service = new ShipmentService(prisma as never, { get: () => provider } as never)
  return { provider, service }
}

let outletId: string
let userId: string
let addressId: string

/** A paid order with an unbooked JNE shipment, ready to book. */
async function paidOrder(shipment: { status?: ShipmentStatus; updatedAt?: Date } = {}) {
  const orderId = randomUUID()
  await prisma.order.create({
    data: {
      id: orderId, orderNumber: `BMS-REC-${orderId.slice(0, 8)}`, userId, addressId, outletId,
      subtotal: 30_000, deliveryFee: 10_000, totalPrice: 40_000, paymentMethod: 'BANK_TRANSFER',
      status: OrderStatus.PROCESSING, shippingProvider: 'jne', shippingService: 'REG',
    },
  })
  const row = await prisma.shipment.create({
    data: { orderId, provider: 'jne', service: 'REG', cost: 10_000, status: shipment.status ?? ShipmentStatus.RATE_SELECTED },
  })
  if (shipment.updatedAt) {
    await prisma.$executeRawUnsafe(`UPDATE "Shipment" SET "updatedAt" = $1 WHERE id = $2`, shipment.updatedAt, row.id)
  }
  return { orderId, shipmentId: row.id }
}

const legacy = { order: randomUUID(), shipment: randomUUID() }

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('rec').withUsername('rec').withPassword('rec').start()
  url = postgres.getConnectionUri()
  workDir = mkdtempSync(join(tmpdir(), 'booking-recovery-'))
  cpSync(join(BACKEND, 'prisma', 'schema.prisma'), join(workDir, 'prisma', 'schema.prisma'))
  cpSync(join(BACKEND, 'prisma', 'migrations', 'migration_lock.toml'), join(workDir, 'prisma', 'migrations', 'migration_lock.toml'))
  prisma = new PrismaClient({ datasources: { db: { url } } })

  // Everything up to (not including) the new migration, then "existing" rows.
  const before = readdirSync(join(BACKEND, 'prisma', 'migrations')).filter((n) => n !== 'migration_lock.toml' && n !== NEW_MIGRATION).sort()
  deploy(before)
  userId = randomUUID()
  addressId = randomUUID()
  outletId = randomUUID()
  await prisma.$executeRawUnsafe(`INSERT INTO "User" (id, email, name, "updatedAt") VALUES ('${userId}', 'rec-${userId}@test.local', 'Pelanggan', now())`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Address" (id, "userId", label, "recipientName", phone, "fullAddress", "postalCode", latitude, longitude, "updatedAt")
     VALUES ('${addressId}', '${userId}', 'Rumah', 'Pelanggan', '081200000000', 'Jl. Melati 5', '40112', 0, 0, now())`,
  )
  await prisma.$executeRawUnsafe(`INSERT INTO "Outlet" (id, name, "postalCode", "updatedAt") VALUES ('${outletId}', 'Outlet', '40286', now())`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Order" (id, "orderNumber", "userId", "addressId", "outletId", subtotal, "deliveryFee", "totalPrice", "paymentMethod", status, "shippingProvider", "shippingService", "updatedAt")
     VALUES ('${legacy.order}', 'BMS-LEGACY-${legacy.order.slice(0, 8)}', '${userId}', '${addressId}', '${outletId}', 30000, 10000, 40000, 'BANK_TRANSFER', 'PROCESSING', 'jne', 'REG', now())`,
  )
  // A legacy claim left by a crashed run long ago (stale PENDING, no owner column yet).
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Shipment" (id, "orderId", provider, service, cost, status, metadata, "updatedAt")
     VALUES ('${legacy.shipment}', '${legacy.order}', 'jne', 'REG', 10000, 'PENDING', '{"jne":{"pickupDatetime":"2026-11-23T10:00:00.000Z"}}', now() - interval '2 hours')`,
  )
}, 240_000)

afterAll(async () => {
  await prisma?.$disconnect()
  await postgres?.stop()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('migration 20261121090000 (additive)', () => {
  it('leaves existing rows unchanged with NULL owner columns, and is applied by migrate deploy', async () => {
    const [beforeRow] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "Shipment" WHERE id = '${legacy.shipment}'`)
    const out = deploy([NEW_MIGRATION])
    expect(out).toContain(NEW_MIGRATION)
    // Different text on purpose: the cached plan of the first SELECT * predates the new columns.
    const [afterRow] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT s.* FROM "Shipment" s WHERE s.id = '${legacy.shipment}'`)
    expect(afterRow).toEqual({ ...beforeRow, bookingAttemptId: null, bookingAttemptStartedAt: null })
  })

  it('a legacy stale PENDING (no owner) is still reclaimed and booked once', async () => {
    const { provider, service } = courier()
    provider.createShipment.mockResolvedValue(booked('0291492600000101'))
    const outcome = await service.retry(legacy.order)
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: '0291492600000101' })
    expect(provider.createShipment).toHaveBeenCalledTimes(1)
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: legacy.shipment } })
    expect(row.bookingAttemptId).toEqual(expect.any(String))
    expect(row.metadata).toEqual({ jne: { pickupDatetime: '2026-11-23T10:00:00.000Z' } }) // untouched
  })
})

describe('atomic claim under real concurrency', () => {
  it('12 simultaneous bookings of one shipment: one owner, one courier call, one SHIPPED event', async () => {
    const { orderId, shipmentId } = await paidOrder()
    const { provider, service } = courier()
    provider.createShipment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150)) // the courier takes a while
      return booked('0291492600000202')
    })

    const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? service.retry(orderId) : service.createForOrderSafe(orderId))))

    expect(provider.createShipment).toHaveBeenCalledTimes(1)
    for (const o of outcomes) {
      expect(o.ok ? `ok:${o.trackingNumber}` : `skip:${o.error}`).toMatch(/^(ok:0291492600000202|skip:Shipment booking already in progress)$/)
    }
    expect(outcomes.filter((o) => !o.ok).every((o) => o.error === BOOKING_IN_PROGRESS)).toBe(true)
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(row).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: '0291492600000202', bookingAttemptId: expect.any(String) })
    expect(await prisma.orderEvent.count({ where: { orderId, status: OrderStatus.SHIPPED } })).toBe(1)
  })
})

describe('a stale attempt against a newer one', () => {
  it('parks, reconciles with evidence, re-claims; the stale success hits P2025 and changes nothing', async () => {
    const { orderId, shipmentId } = await paidOrder()
    const { provider, service } = courier()

    // Attempt A reaches the courier and hangs.
    const gateA = deferred<ReturnType<typeof booked>>()
    const startedA = deferred<void>()
    provider.createShipment.mockImplementationOnce(async () => { startedA.resolve(); return gateA.promise })
    const attemptA = service.createForOrderSafe(orderId)
    await startedA.promise
    const tokenA = (await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).bookingAttemptId

    // A second caller inside the lease cannot claim.
    expect(await service.retry(orderId)).toMatchObject({ ok: false, error: BOOKING_IN_PROGRESS })

    // The lease expires: the next caller parks the attempt instead of claiming it.
    await prisma.$executeRawUnsafe(`UPDATE "Shipment" SET "bookingAttemptStartedAt" = now() - interval '10 minutes' WHERE id = $1`, shipmentId)
    expect(await service.retry(orderId)).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED })

    // not_booked: no evidence -> refused; with JNE's confirmation -> FAILED.
    await expect(service.reconcileBooking(orderId, { outcome: 'not_booked' })).rejects.toThrow(/confirmNoActiveBooking/)
    await service.reconcileBooking(orderId, { outcome: 'not_booked', ...EVIDENCE }, 'ops@masular.test')

    // Attempt B claims (new owner) and hangs at the courier too.
    const gateB = deferred<ReturnType<typeof booked>>()
    const startedB = deferred<void>()
    provider.createShipment.mockImplementationOnce(async () => { startedB.resolve(); return gateB.promise })
    const attemptB = service.retry(orderId)
    await startedB.promise
    const rowB = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(rowB.bookingAttemptId).not.toBe(tokenA)
    expect(rowB.status).toBe(ShipmentStatus.PENDING)

    // A comes back with an AWB: its write is CAS'd on token A -> real P2025, rolled back.
    gateA.resolve(booked('0291492600000301'))
    expect(await attemptA).toMatchObject({ ok: false, status: ShipmentStatus.UNKNOWN })
    const afterA = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(afterA).toMatchObject({
      status: ShipmentStatus.PENDING, trackingNumber: null,
      bookingAttemptId: rowB.bookingAttemptId, bookingAttemptStartedAt: rowB.bookingAttemptStartedAt,
    })
    expect(afterA.metadata).toEqual(rowB.metadata)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.PROCESSING)

    // B completes normally.
    gateB.resolve(booked('0291492600000302'))
    expect(await attemptB).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: '0291492600000302' })
    expect(await prisma.orderEvent.count({ where: { orderId, status: OrderStatus.SHIPPED } })).toBe(1)
  })
})

describe('not_booked reads the real integration log', () => {
  it('refuses while JNE is on record as having issued a cnote, until it is confirmed cancelled', async () => {
    const { orderId, shipmentId } = await paidOrder()
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { status: ShipmentStatus.UNKNOWN, bookingAttemptId: randomUUID(), bookingAttemptStartedAt: new Date(Date.now() - LEASE_MS - 60_000), metadata: { reconciliationRequired: true } },
    })
    await prisma.integrationApiLog.create({
      data: {
        provider: 'JNE', operation: 'PICKUP_CASHLESS', direction: 'OUTBOUND', operationId: randomUUID(),
        attempt: null, orderId, correlationId: '0291492600000401', applicationOutcome: 'OK',
      },
    })
    const { service } = courier()

    await expect(service.reconcileBooking(orderId, { outcome: 'not_booked', ...EVIDENCE })).rejects.toThrow(/0291492600000401/)
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe(ShipmentStatus.UNKNOWN)

    await service.reconcileBooking(orderId, { outcome: 'not_booked', ...EVIDENCE, cancelledAtCourier: true })
    const row = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(row.status).toBe(ShipmentStatus.FAILED)
    expect(row.metadata).toMatchObject({ booking: { reconciliation: { outcome: 'not_booked', cancelledAtCourier: true, cancelledTrackingNumber: '0291492600000401' } } })
  })
})

describe('generic admin PATCH / DELETE against real Prisma', () => {
  const admin = () => new AdminService(prisma as never, {} as never)

  it('UNKNOWN: status, AWB and delete are refused; the row and its recovery metadata are untouched', async () => {
    const { shipmentId } = await paidOrder()
    const recovery = { reconciliationRequired: true, booking: { unrecorded: { provider: 'jne', trackingNumber: '0291492600000501', providerShipmentId: '0291492600000501', bookedAt: '2026-11-21T03:00:00.000Z', persistError: 'x' } } }
    await prisma.shipment.update({ where: { id: shipmentId }, data: { status: ShipmentStatus.UNKNOWN, bookingAttemptId: randomUUID(), metadata: recovery } })
    const before = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })

    await expect(admin().updateShipment(shipmentId, { status: ShipmentStatus.FAILED } as never)).rejects.toThrow(/reconcile/)
    await expect(admin().updateShipment(shipmentId, { status: ShipmentStatus.RATE_SELECTED } as never)).rejects.toThrow(/reconcile/)
    await expect(admin().updateShipment(shipmentId, { trackingNumber: '0291492600000501' } as never)).rejects.toThrow(/reconcile/)
    await admin().updateShipment(shipmentId, { metadata: { reconciliationRequired: false, booking: null } } as never) // no-op
    await expect(admin().deleteShipment(shipmentId)).rejects.toThrow(/reconcile/)

    const after = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
    expect(after).toEqual(before)
  })

  it('owned PENDING: cannot be reset or deleted', async () => {
    const { shipmentId } = await paidOrder()
    const owner = randomUUID()
    await prisma.shipment.update({ where: { id: shipmentId }, data: { status: ShipmentStatus.PENDING, bookingAttemptId: owner, bookingAttemptStartedAt: new Date() } })
    await expect(admin().updateShipment(shipmentId, { status: ShipmentStatus.FAILED } as never)).rejects.toThrow(/booking attempt owns/)
    await expect(admin().deleteShipment(shipmentId)).rejects.toThrow(/booking attempt owns/)
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: owner })
  })

  it('ordinary shipments: compare-and-set edits, metadata merge and draft delete still work', async () => {
    const { shipmentId } = await paidOrder()
    await admin().updateShipment(shipmentId, { cost: 12_500, status: ShipmentStatus.FAILED } as never)
    await admin().updateShipment(shipmentId, { metadata: { note: 'called customer' } } as never)
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({ cost: 12_500, status: ShipmentStatus.FAILED, metadata: { note: 'called customer' } })
    await admin().updateShipment(shipmentId, { trackingNumber: '0291492600000502', status: ShipmentStatus.CREATED } as never) // manual fulfilment
    expect(await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).toMatchObject({ trackingNumber: '0291492600000502' })

    const draft = await paidOrder()
    await admin().deleteShipment(draft.shipmentId)
    expect(await prisma.shipment.findUnique({ where: { id: draft.shipmentId } })).toBeNull()
  })
})
