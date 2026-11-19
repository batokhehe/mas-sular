/**
 * "Stok Produk" admin adjustment (StockTransferService.adjustStock) against real
 * PostgreSQL 16 (./world), with the REAL InventoryReservationService.
 *
 * Production finding 2026-11-18 (product 9aa8c8db): an adjustment set stock 12
 * while 13 units were held, leaving available = -1. adjustStock now runs in one
 * transaction under the ProductInventory row lock and refuses stock < reserved.
 *
 * Races hold an interactive transaction (one pooled connection) per participant
 * while waiting on a barrier, so they never exceed 3 participants (the Prisma pool
 * size on a 1-vCPU runner) - see inventory-concurrency.int-spec.ts.
 */
import { PaymentMethod, ReservationStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { StockTransferService } from '../../src/modules/inventory/stock-transfer.service'
import { closeWorld, getWorld, IntegrationWorld } from './world'

const TX = { timeout: 30_000, maxWait: 30_000 }
const ROUNDS = 6

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

describe('Stok Produk adjustment integrity (PostgreSQL)', () => {
  let world: IntegrationWorld
  let reservations: InventoryReservationService
  let adjuster: StockTransferService

  beforeAll(async () => {
    world = await getWorld()
    reservations = new InventoryReservationService(world.prisma)
    adjuster = new StockTransferService(world.prisma)
  }, 300_000)

  afterAll(() => closeWorld(), 120_000)

  /** A product + outlet, optionally with a Stok Produk row, and `orders` disposable orders. */
  async function fixture(opts: { stock?: number; withRow?: boolean; orders?: number } = {}) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const category = await prisma.category.create({ data: { name: `adj-${uid}`, slug: `adj-${uid}` } })
    const product = await prisma.product.create({
      data: {
        slug: `adj-${uid}`, sku: `ADJ-${uid}`, name: `Adj ${uid}`, description: 'x',
        price: 10_000, imageUrl: '/x.png', stock: 999, categoryId: category.id, status: 'ACTIVE', weightGram: 500,
      },
    })
    const outlet = await prisma.outlet.create({ data: { name: `ADJ-${uid}`, isActive: true } })
    if (opts.withRow !== false) {
      const stock = opts.stock ?? 0
      await prisma.productInventory.create({ data: { productId: product.id, outletId: outlet.id, stock, reserved: 0, available: stock } })
    }
    const user = await prisma.user.create({ data: { email: `adj-${uid}@test.local`, name: 'Adj' } })
    const address = await prisma.address.create({
      data: { userId: user.id, label: 'H', recipientName: 'Adj', phone: '6281200000000', fullAddress: 'Jl Test', latitude: 0, longitude: 0 },
    })
    const orders: string[] = []
    for (let i = 0; i < (opts.orders ?? 0); i += 1) {
      const o = await prisma.order.create({
        data: {
          orderNumber: `ADJ-${uid}-${i}`, userId: user.id, addressId: address.id,
          subtotal: 10_000, deliveryFee: 0, totalPrice: 10_000, paymentMethod: PaymentMethod.BANK_TRANSFER,
        },
      })
      orders.push(o.id)
    }
    return { productId: product.id, outletId: outlet.id, orders, uid }
  }

  const adjust = (productId: string, outletId: string, stock: number) =>
    adjuster.adjustStock({ productId, outletId, stock } as never, 'admin-int')

  const reserve = (orderId: string, productId: string, outletId: string, quantity: number) =>
    world.prisma.$transaction((tx) =>
      reservations.reserveForOrder(tx, { orderId, items: [{ productId, quantity }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId }), TX)

  async function row(productId: string, outletId: string) {
    return world.prisma.productInventory.findUniqueOrThrow({ where: { productId_outletId: { productId, outletId } } })
  }

  async function ledgerReserved(productId: string) {
    const agg = await world.prisma.inventoryReservation.aggregate({
      where: { productId, status: ReservationStatus.RESERVED },
      _sum: { reservedQty: true },
    })
    return agg._sum.reservedQty ?? 0
  }

  /** The integrity invariant: never oversold, `available` exact, column == RESERVED ledger. */
  async function expectIntegrity(productId: string, outletId: string) {
    const r = await row(productId, outletId)
    expect(r.reserved).toBeLessThanOrEqual(r.stock)
    expect(r.available).toBe(r.stock - r.reserved)
    expect(r.available).toBeGreaterThanOrEqual(0)
    expect(r.reserved).toBe(await ledgerReserved(productId))
    return r
  }

  async function auditCount(productId: string) {
    return world.prisma.auditLog.count({ where: { action: 'inventory.adjust', after: { path: ['productId'], equals: productId } } })
  }

  // ------------------------------------------------------- validation -----

  it('ADJ-001 raises stock above the reserved quantity', async () => {
    const f = await fixture({ stock: 5, orders: 1 })
    await reserve(f.orders[0], f.productId, f.outletId, 3)

    await adjust(f.productId, f.outletId, 10)

    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 10, reserved: 3, available: 7 })
  })

  it('ADJ-002 accepts stock EQUAL to the reserved quantity (available 0)', async () => {
    const f = await fixture({ stock: 5, orders: 1 })
    await reserve(f.orders[0], f.productId, f.outletId, 3)

    await adjust(f.productId, f.outletId, 3)

    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 3, reserved: 3, available: 0 })
  })

  it('ADJ-003 rejects stock BELOW the reserved quantity (the 9aa8c8db case): row and audit unchanged', async () => {
    const f = await fixture({ stock: 13, orders: 1 })
    await reserve(f.orders[0], f.productId, f.outletId, 13)
    const auditsBefore = await auditCount(f.productId)

    await expect(adjust(f.productId, f.outletId, 12)).rejects.toThrow(/below the reserved quantity: 13/)

    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 13, reserved: 13, available: 0 })
    expect(await auditCount(f.productId)).toBe(auditsBefore)
  })

  it('ADJ-004 creates a missing Stok Produk row with reserved 0 and audits previousStock null', async () => {
    const f = await fixture({ withRow: false })

    await adjust(f.productId, f.outletId, 6)

    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 6, reserved: 0, available: 6 })
    const audit = await world.prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.adjust', after: { path: ['productId'], equals: f.productId } } })
    expect(audit.after).toMatchObject({ newStock: 6, previousStock: null })
  })

  // ---------------------------------------------------------- rollback -----

  it('ADJ-005 a failing adjustment rolls back completely: no row created, no audit', async () => {
    const f = await fixture({ withRow: false })
    const missingOutlet = randomUUID()

    await expect(adjust(f.productId, missingOutlet, 4)).rejects.toThrow()

    expect(await world.prisma.productInventory.count({ where: { productId: f.productId } })).toBe(0)
    expect(await auditCount(f.productId)).toBe(0)
  })

  // ------------------------------------------------------- concurrency -----

  it('ADJ-006 concurrent adjustments of one row serialize: the final row is exactly one of the requested values', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture({ stock: 5, orders: 1 })
      await reserve(f.orders[0], f.productId, f.outletId, 2)
      const values = [7, 9, 11]
      const gate = barrier(values.length)

      const settled = await Promise.allSettled(values.map(async (v) => { await gate(); return adjust(f.productId, f.outletId, v) }))

      expect(settled.every((s) => s.status === 'fulfilled')).toBe(true)
      const r = await expectIntegrity(f.productId, f.outletId)
      expect(values).toContain(r.stock)
      expect(r.reserved).toBe(2) // no adjustment lost or overwrote the hold
      expect(await auditCount(f.productId)).toBe(values.length)
    }
  })

  it('ADJ-007 concurrent FIRST-time adjustments of a missing row: one row, both succeed, no unique-key failure', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const f = await fixture({ withRow: false })
      const gate = barrier(2)

      const settled = await Promise.allSettled([4, 8].map(async (v) => { await gate(); return adjust(f.productId, f.outletId, v) }))

      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(await world.prisma.productInventory.count({ where: { productId: f.productId } })).toBe(1)
      const r = await expectIntegrity(f.productId, f.outletId)
      expect([4, 8]).toContain(r.stock)
    }
  })

  it('ADJ-008 reservation racing an adjustment that would undercut it: never both, invariant always holds', async () => {
    const outcomes: string[] = []
    for (let round = 0; round < ROUNDS; round += 1) {
      // stock 5; reserve 3 races "set stock to 2": either the reservation wins (then
      // 2 < 3 reserved is refused) or the adjustment wins (then 3 > 2 available is refused).
      const f = await fixture({ stock: 5, orders: 1 })
      const gate = barrier(2)
      const [res, adj] = await Promise.allSettled([
        (async () => { await gate(); return reserve(f.orders[0], f.productId, f.outletId, 3) })(),
        (async () => { await gate(); return adjust(f.productId, f.outletId, 2) })(),
      ])

      const r = await expectIntegrity(f.productId, f.outletId)
      if (res.status === 'fulfilled') {
        expect(adj.status).toBe('rejected')
        expect(String((adj as PromiseRejectedResult).reason?.message)).toMatch(/below the reserved quantity/)
        expect(r).toMatchObject({ stock: 5, reserved: 3, available: 2 })
        outcomes.push('reservation-first')
      } else {
        expect(adj.status).toBe('fulfilled')
        expect(String(res.reason?.message)).toMatch(/Insufficient available stock/)
        expect(r).toMatchObject({ stock: 2, reserved: 0, available: 2 })
        outcomes.push('adjustment-first')
      }
    }
    expect(outcomes).toHaveLength(ROUNDS)
  })

  it('ADJ-009 an adjustment WAITS for an in-flight reservation holding the row lock, then sees its hold', async () => {
    const f = await fixture({ stock: 5, orders: 1 })
    const timeline: string[] = []
    let releaseReservation!: () => void
    const reservationMayCommit = new Promise<void>((resolve) => (releaseReservation = resolve))
    let reservationHasLock!: () => void
    const locked = new Promise<void>((resolve) => (reservationHasLock = resolve))

    const reservation = world.prisma.$transaction(async (tx) => {
      await reservations.reserveForOrder(tx, { orderId: f.orders[0], items: [{ productId: f.productId, quantity: 4 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId: f.outletId })
      timeline.push('R reserved 4 (row lock held)')
      reservationHasLock()
      await reservationMayCommit
      timeline.push('R committing')
    }, TX).then(() => timeline.push('R committed'))

    await locked
    const adjustment = adjust(f.productId, f.outletId, 3)
      .then(() => timeline.push('A adjusted'))
      .catch((err: Error) => timeline.push(`A refused: ${err.message.split(':')[0]}`))

    await new Promise((resolve) => setTimeout(resolve, 1_500))
    timeline.push('after 1.5s wait')
    releaseReservation()
    await Promise.all([reservation, adjustment])

    expect(timeline.slice(0, 3)).toEqual(['R reserved 4 (row lock held)', 'after 1.5s wait', 'R committing'])
    expect(timeline.slice(3).sort()).toEqual(['A refused: Stock cannot be set below the reserved quantity', 'R committed'])
    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 5, reserved: 4, available: 1 })
  })

  it('ADJ-010 adjustment then commit/release keep the row and the ledger consistent', async () => {
    const f = await fixture({ stock: 4, orders: 2 })
    await reserve(f.orders[0], f.productId, f.outletId, 2)
    await reserve(f.orders[1], f.productId, f.outletId, 1)
    await adjust(f.productId, f.outletId, 6)

    await world.prisma.$transaction((tx) => reservations.commitForOrder(tx, f.orders[0]), TX)
    await world.prisma.$transaction((tx) => reservations.releaseForOrder(tx, f.orders[1]), TX)

    expect(await expectIntegrity(f.productId, f.outletId)).toMatchObject({ stock: 4, reserved: 0, available: 4 })
  })
})
