/**
 * Track 3.1 — reservation-level inventory hold ownership (inventoryHoldApplied),
 * against real PostgreSQL 16 (./world) with the REAL InventoryReservationService.
 *
 * Production finding (product 11699095): a reservation created before its product
 * had a Stok Produk row held nothing there, but its expiry ran after the row was
 * created and decremented `reserved` anyway (drift -1). Commit / release / expiry
 * now follow the reservation's own inventoryHoldApplied, never the current
 * existence of a ProductInventory row.
 *
 * Races hold one pooled connection per participant while waiting on a barrier, so
 * they never exceed 3 participants (Prisma pool on a 1-vCPU runner).
 *
 * NOTE: run this on CI or a dedicated test host, not on the production host
 * (Testcontainers PostgreSQL + RabbitMQ).
 */
import { PaymentMethod, PaymentStatus, ReservationStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { closeWorld, getWorld, IntegrationWorld } from './world'

const TX = { timeout: 30_000, maxWait: 30_000 }
const ROUNDS = 6
const MIGRATION = join(__dirname, '..', '..', 'prisma', 'migrations', '20261119120000_reservation_inventory_hold_applied', 'migration.sql')

function barrier(size: number) {
  let arrived = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  return async () => {
    arrived += 1
    if (arrived >= size) release()
    await gate
  }
}

describe('Reservation inventory hold ownership (PostgreSQL)', () => {
  let world: IntegrationWorld
  let svc: InventoryReservationService

  beforeAll(async () => {
    world = await getWorld()
    svc = new InventoryReservationService(world.prisma)
  }, 300_000)

  afterAll(() => closeWorld(), 120_000)

  /** Product + outlet (+ optional Stok Produk row) + orders allocated to that outlet. */
  async function fixture(opts: { stock?: number; withRow?: boolean; master?: number; orders?: number; orderOutlet?: boolean } = {}) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const category = await prisma.category.create({ data: { name: `hold-${uid}`, slug: `hold-${uid}` } })
    const product = await prisma.product.create({
      data: {
        slug: `hold-${uid}`, sku: `HOLD-${uid}`, name: `Hold ${uid}`, description: 'x',
        price: 10_000, imageUrl: '/x.png', stock: opts.master ?? 50, categoryId: category.id, status: 'ACTIVE', weightGram: 500,
      },
    })
    const outlet = await prisma.outlet.create({ data: { name: `HOLD-${uid}`, isActive: true } })
    if (opts.withRow !== false) {
      const stock = opts.stock ?? 5
      await prisma.productInventory.create({ data: { productId: product.id, outletId: outlet.id, stock, reserved: 0, available: stock } })
    }
    const user = await prisma.user.create({ data: { email: `hold-${uid}@test.local`, name: 'Hold' } })
    const address = await prisma.address.create({
      data: { userId: user.id, label: 'H', recipientName: 'Hold', phone: '6281200000000', fullAddress: 'Jl Test', latitude: 0, longitude: 0 },
    })
    const orders: Array<{ id: string; paymentId: string }> = []
    for (let i = 0; i < (opts.orders ?? 1); i += 1) {
      const o = await prisma.order.create({
        data: {
          orderNumber: `HOLD-${uid}-${i}`, userId: user.id, addressId: address.id, status: 'PENDING',
          outletId: opts.orderOutlet === false ? null : outlet.id,
          subtotal: 10_000, deliveryFee: 0, totalPrice: 10_000, paymentMethod: PaymentMethod.BANK_TRANSFER,
          items: { create: [{ productId: product.id, productName: product.name, unitPrice: 10_000, quantity: 1 }] },
          payment: { create: { method: PaymentMethod.BANK_TRANSFER, amount: 10_000, status: PaymentStatus.PENDING } },
        },
        include: { payment: true },
      })
      orders.push({ id: o.id, paymentId: o.payment!.id })
    }
    return { productId: product.id, outletId: outlet.id, orders, uid }
  }

  /** A legacy reservation exactly as the pre-Stok-Produk code wrote it: no hold placed. */
  async function legacyReservation(orderId: string, productId: string, outletId: string | null, qty: number) {
    const r = await world.prisma.inventoryReservation.create({
      data: { orderId, productId, outletId, reservedQty: qty, status: ReservationStatus.RESERVED, inventoryHoldApplied: false },
    })
    await world.prisma.inventoryReservationHistory.create({ data: { reservationId: r.id, status: ReservationStatus.RESERVED, note: 'Reservation created' } })
    return r
  }

  const reserve = (orderId: string, productId: string, outletId: string, quantity: number) =>
    world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, { orderId, items: [{ productId, quantity }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId }), TX)

  const row = (productId: string, outletId: string) =>
    world.prisma.productInventory.findUniqueOrThrow({ where: { productId_outletId: { productId, outletId } } })

  const master = async (productId: string) => (await world.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock

  /** Column == RESERVED ledger of the reservations that HOLD this row; never oversold. */
  async function expectHeldIntegrity(productId: string, outletId: string) {
    const r = await row(productId, outletId)
    const agg = await world.prisma.inventoryReservation.aggregate({
      where: { productId, outletId, status: ReservationStatus.RESERVED, inventoryHoldApplied: true },
      _sum: { reservedQty: true },
    })
    expect(r.reserved).toBe(agg._sum.reservedQty ?? 0)
    expect(r.reserved).toBeLessThanOrEqual(r.stock)
    expect(r.available).toBe(r.stock - r.reserved)
    return r
  }

  // --------------------------------------------------------- new holds -----

  it('HOLD-001 a new reservation records inventoryHoldApplied=true atomically with its hold', async () => {
    const f = await fixture({ stock: 5 })
    await reserve(f.orders[0].id, f.productId, f.outletId, 2)

    const r = await world.prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: f.orders[0].id } })
    expect(r.inventoryHoldApplied).toBe(true)
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 5, reserved: 2 })
  })

  it('HOLD-002 a failed reservation leaves neither a hold nor a marked reservation (rollback)', async () => {
    const f = await fixture({ stock: 1 })
    await expect(world.prisma.$transaction(async (tx) => {
      await svc.reserveForOrder(tx, { orderId: f.orders[0].id, items: [{ productId: f.productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId: f.outletId })
      throw new Error('checkout failed after reserving')
    }, TX)).rejects.toThrow('checkout failed after reserving')

    expect(await world.prisma.inventoryReservation.count({ where: { orderId: f.orders[0].id } })).toBe(0)
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 1, reserved: 0 })
  })

  // ------------------------------------------- legacy: the 11699095 scenario --

  it('HOLD-003 expiry of a LEGACY reservation does not touch a Stok Produk row created after it (no drift)', async () => {
    const f = await fixture({ withRow: false, master: 20 })
    const legacy = await legacyReservation(f.orders[0].id, f.productId, f.outletId, 1)
    // The product gains its Stok Produk row afterwards (the 2026-11-04 adoption).
    await world.prisma.productInventory.create({ data: { productId: f.productId, outletId: f.outletId, stock: 10, reserved: 0, available: 10 } })
    await world.prisma.payment.update({ where: { id: f.orders[0].paymentId }, data: { status: PaymentStatus.FAILED } })

    expect(await svc.expireReservation(legacy.id)).toBe(true)

    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 10, reserved: 0, available: 10 })
    expect(await master(f.productId)).toBe(20)
  })

  it('HOLD-004 commit of a legacy reservation settles against Product.stock only, never the Stok Produk row', async () => {
    const f = await fixture({ withRow: false, master: 20 })
    await legacyReservation(f.orders[0].id, f.productId, f.outletId, 3)
    await world.prisma.productInventory.create({ data: { productId: f.productId, outletId: f.outletId, stock: 10, reserved: 0, available: 10 } })

    expect(await world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX)).toBe(1)

    expect(await master(f.productId)).toBe(17) // legacy semantics preserved
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 10, reserved: 0 })
  })

  it('HOLD-005 release of a COMMITTED legacy reservation restocks Product.stock (where its commit deducted)', async () => {
    const f = await fixture({ withRow: false, master: 20 })
    await legacyReservation(f.orders[0].id, f.productId, f.outletId, 3)
    await world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX)
    await world.prisma.productInventory.create({ data: { productId: f.productId, outletId: f.outletId, stock: 10, reserved: 0, available: 10 } })

    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[0].id), TX)

    expect(await master(f.productId)).toBe(20)
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 10, reserved: 0 })
  })

  it('HOLD-006 a legacy reservation and a held one for the same row settle independently', async () => {
    const f = await fixture({ withRow: false, master: 20, orders: 2 })
    await legacyReservation(f.orders[0].id, f.productId, f.outletId, 1)
    await world.prisma.productInventory.create({ data: { productId: f.productId, outletId: f.outletId, stock: 5, reserved: 0, available: 5 } })
    await reserve(f.orders[1].id, f.productId, f.outletId, 2)

    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[0].id), TX) // legacy: frees nothing
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 5, reserved: 2 })
    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[1].id), TX) // held: frees 2
    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 5, reserved: 0 })
  })

  // ------------------------------------------------------- idempotency -----

  it('HOLD-007 commit and release are idempotent: repeats never move counters twice', async () => {
    const f = await fixture({ stock: 6, orders: 2 })
    await reserve(f.orders[0].id, f.productId, f.outletId, 2)
    await reserve(f.orders[1].id, f.productId, f.outletId, 1)

    expect(await world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX)).toBe(1)
    expect(await world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX)).toBe(0)
    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[1].id), TX)
    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[1].id), TX)

    expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 4, reserved: 0, available: 4 })
  })

  it('HOLD-008 a held reservation whose Stok Produk row disappeared moves no counters and never falls back to Product.stock', async () => {
    const f = await fixture({ stock: 5, master: 30 })
    await reserve(f.orders[0].id, f.productId, f.outletId, 2)
    await world.prisma.productInventory.delete({ where: { productId_outletId: { productId: f.productId, outletId: f.outletId } } })

    expect(await world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX)).toBe(1)

    expect(await master(f.productId)).toBe(30)
    const r = await world.prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: f.orders[0].id } })
    expect(r.status).toBe(ReservationStatus.COMMITTED)
  })

  // -------------------------------------------------------- concurrency -----

  it('HOLD-009 concurrent commit vs expiry of one held reservation: exactly one wins, the hold is freed once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture({ stock: 5 })
      await reserve(f.orders[0].id, f.productId, f.outletId, 2)
      const res = await world.prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: f.orders[0].id } })
      await world.prisma.payment.update({ where: { id: f.orders[0].paymentId }, data: { status: PaymentStatus.FAILED } })
      const gate = barrier(2)

      const [committed, expired] = await Promise.all([
        (async () => { await gate(); return world.prisma.$transaction((tx) => svc.commitForOrder(tx, f.orders[0].id), TX) })(),
        (async () => { await gate(); return svc.expireReservation(res.id) })(),
      ])

      expect([committed === 1, expired].filter(Boolean)).toHaveLength(1)
      const r = await expectHeldIntegrity(f.productId, f.outletId)
      expect(r.reserved).toBe(0)
      expect(r.stock).toBe(committed === 1 ? 3 : 5)
    }
  })

  it('HOLD-010 concurrent release vs expiry of a legacy reservation never touches the Stok Produk row', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture({ withRow: false, master: 20 })
      const legacy = await legacyReservation(f.orders[0].id, f.productId, f.outletId, 1)
      await world.prisma.productInventory.create({ data: { productId: f.productId, outletId: f.outletId, stock: 4, reserved: 0, available: 4 } })
      await world.prisma.payment.update({ where: { id: f.orders[0].paymentId }, data: { status: PaymentStatus.FAILED } })
      const gate = barrier(2)

      await Promise.all([
        (async () => { await gate(); return world.prisma.$transaction((tx) => svc.releaseForOrder(tx, f.orders[0].id), TX) })(),
        (async () => { await gate(); return svc.expireReservation(legacy.id) })(),
      ])

      expect(await expectHeldIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 4, reserved: 0, available: 4 })
      expect(await master(f.productId)).toBe(20)
    }
  })

  // ---------------------------------------------------- migration backfill --

  it('HOLD-011 the migration backfill marks holds from historical evidence, never from current row existence', async () => {
    const { prisma } = world
    // a) order allocated to the outlet, row existed before the reservation -> held
    const a = await fixture({ withRow: false })
    await prisma.productInventory.create({ data: { productId: a.productId, outletId: a.outletId, stock: 5, reserved: 1, available: 4, createdAt: new Date('2026-01-01T00:00:00Z') } })
    const ra = await legacyReservation(a.orders[0].id, a.productId, a.outletId, 1)
    // b) the row was created AFTER the reservation (the 11699095 case) -> not held
    const b = await fixture({ withRow: false })
    const rb = await legacyReservation(b.orders[0].id, b.productId, b.outletId, 1)
    await prisma.productInventory.create({ data: { productId: b.productId, outletId: b.outletId, stock: 5, reserved: 0, available: 5, createdAt: new Date(Date.now() + 60_000) } })
    // c) createdAt rewritten later, but the AUDIT trail proves the row existed before -> held
    const c = await fixture({ withRow: false })
    const piC = await prisma.productInventory.create({ data: { productId: c.productId, outletId: c.outletId, stock: 5, reserved: 1, available: 4, createdAt: new Date(Date.now() + 120_000) } })
    await prisma.auditLog.create({ data: { action: 'inventory.adjust', entity: 'ProductInventory', entityId: piC.id, createdAt: new Date('2026-01-01T00:00:00Z'), after: { productId: c.productId } } })
    const rc = await legacyReservation(c.orders[0].id, c.productId, c.outletId, 1)
    // d) the order had no allocated outlet (old code reserved on the legacy path) -> not held
    const d = await fixture({ withRow: false, orderOutlet: false })
    await prisma.productInventory.create({ data: { productId: d.productId, outletId: d.outletId, stock: 5, reserved: 0, available: 5, createdAt: new Date('2026-01-01T00:00:00Z') } })
    const rd = await legacyReservation(d.orders[0].id, d.productId, d.outletId, 1)

    // Re-run exactly the migration's backfill statement over reset markers.
    await prisma.inventoryReservation.updateMany({ where: { id: { in: [ra.id, rb.id, rc.id, rd.id] } }, data: { inventoryHoldApplied: false } })
    const sql = readFileSync(MIGRATION, 'utf8')
    const backfill = sql.slice(sql.indexOf('WITH pi AS'))
    await prisma.$executeRawUnsafe(backfill)

    const marked = async (id: string) => (await prisma.inventoryReservation.findUniqueOrThrow({ where: { id } })).inventoryHoldApplied
    expect(await marked(ra.id)).toBe(true)
    expect(await marked(rb.id)).toBe(false)
    expect(await marked(rc.id)).toBe(true)
    expect(await marked(rd.id)).toBe(false)

    // Idempotent: running it again changes nothing.
    await prisma.$executeRawUnsafe(backfill)
    expect([await marked(ra.id), await marked(rb.id), await marked(rc.id), await marked(rd.id)]).toEqual([true, false, true, false])
  })
})
