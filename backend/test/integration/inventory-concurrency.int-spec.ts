/**
 * PAXELBOX-61AG.3.25 — BF-017: the last unit of stock must not be sold twice.
 *
 * Exercises the REAL InventoryReservationService against the real PostgreSQL 16
 * container from ./world. Nothing about the reservation logic is reimplemented
 * here: a test that re-ran the SQL by hand would prove something about the test,
 * not about the service.
 *
 * Stock model (Ops Batch, "Stok Produk" rule): availability comes ONLY from the
 * per-outlet ProductInventory row (stock - reserved), locked FOR UPDATE. The master
 * Product.stock is never consulted. Every fixture therefore creates its own outlet
 * and Stok Produk row and passes that outletId explicitly: the shared test database
 * holds many active outlets, so relying on "the active outlet" would be
 * nondeterministic. The master stock is deliberately set to a DIFFERENT value
 * (MASTER_DECOY) so any accidental use of it would change the outcome.
 *
 * The races are made DETERMINISTIC rather than left to timing luck: every
 * transaction first takes a real read, then waits on a barrier, so none can commit
 * before all have read.
 */
import { PaymentMethod, ReservationStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { closeWorld, getWorld, IntegrationWorld } from './world'

const TX = { timeout: 30_000, maxWait: 30_000 }

/** Master Product.stock in every fixture: wildly different from Stok Produk on purpose. */
const MASTER_DECOY = 1_000

/** Releases all waiters once `size` of them have arrived. */
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

describe('BF-017 inventory reservation concurrency (Stok Produk / ProductInventory)', () => {
  let world: IntegrationWorld
  let svc: InventoryReservationService

  beforeAll(async () => {
    world = await getWorld()
    svc = new InventoryReservationService(world.prisma)
  }, 300_000)

  // Stop this file's containers so they do not stay alive while later files run.
  afterAll(() => closeWorld(), 120_000)

  async function newOutlet(prefix = 'INV') {
    return world.prisma.outlet.create({ data: { name: `${prefix}-${randomUUID().slice(0, 8)}`, isActive: true } })
  }

  /**
   * A product with a Stok Produk row of `stock` units at its own outlet (or at
   * `opts.outletId`), plus `count` disposable orders. `opts.inventory: false`
   * creates the product WITHOUT any Stok Produk row.
   */
  async function fixture(stock: number, count = 2, opts: { outletId?: string; inventory?: boolean; master?: number } = {}) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const category = await prisma.category.create({ data: { name: `inv-${uid}`, slug: `inv-${uid}` } })
    const product = await prisma.product.create({
      data: {
        slug: `inv-${uid}`, sku: `INV-${uid}`, name: `Inv ${uid}`, description: 'x',
        price: 10_000, imageUrl: '/x.png', stock: opts.master ?? MASTER_DECOY, categoryId: category.id, status: 'ACTIVE', weightGram: 500,
      },
    })
    const outletId = opts.outletId ?? (await newOutlet()).id
    if (opts.inventory !== false) {
      await prisma.productInventory.create({ data: { productId: product.id, outletId, stock, reserved: 0, available: stock } })
    }
    const user = await prisma.user.create({ data: { email: `inv-${uid}@test.local`, name: 'Inv' } })
    const address = await prisma.address.create({
      data: {
        userId: user.id, label: 'H', recipientName: 'Inv', phone: '6281200000000',
        fullAddress: 'Jl Test', latitude: 0, longitude: 0,
      },
    })
    const orders: string[] = []
    for (let i = 0; i < count; i += 1) {
      const o = await prisma.order.create({
        data: {
          orderNumber: `INV-${uid}-${i}`, userId: user.id, addressId: address.id,
          subtotal: 10_000, deliveryFee: 0, totalPrice: 10_000, paymentMethod: PaymentMethod.BANK_TRANSFER,
        },
      })
      orders.push(o.id)
    }
    return { productId: product.id, outletId, orders, userId: user.id, uid }
  }

  /** RESERVED quantity in the reservation ledger for a product. */
  async function ledgerReserved(productId: string) {
    const agg = await world.prisma.inventoryReservation.aggregate({
      where: { productId, status: ReservationStatus.RESERVED },
      _sum: { reservedQty: true },
    })
    return agg._sum.reservedQty ?? 0
  }

  async function piFor(productId: string, outletId: string) {
    return world.prisma.productInventory.findUniqueOrThrow({ where: { productId_outletId: { productId, outletId } } })
  }

  async function masterStock(productId: string) {
    return (await world.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock
  }

  /**
   * The ledger and the Stok Produk row agree, nothing is oversold, the stored
   * `available` column matches stock - reserved, and the master stock is untouched.
   */
  async function expectConsistent(productId: string, outletId: string) {
    const pi = await piFor(productId, outletId)
    expect(pi.reserved).toBe(await ledgerReserved(productId))
    expect(pi.reserved).toBeLessThanOrEqual(pi.stock)
    expect(pi.stock - pi.reserved).toBeGreaterThanOrEqual(0)
    expect(pi.available).toBe(pi.stock - pi.reserved)
    expect(await masterStock(productId)).toBe(MASTER_DECOY)
    return pi
  }

  const reserveTx = (orderId: string, productId: string, quantity: number, outletId: string) =>
    world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, { orderId, items: [{ productId, quantity }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId }), TX)

  /**
   * Overlapping reservation transactions, each taking a real read before any may
   * proceed. Every participant holds an interactive transaction (one pooled
   * connection) while it waits on the barrier, so a race may not have more
   * participants than the Prisma pool has connections (cpus x 2 + 1 = 3 on a
   * 1-vCPU runner) - beyond that the barrier starves the pool and the test hangs.
   */
  async function race(productId: string, outletId: string, orders: string[], quantity = 1) {
    const gate = barrier(orders.length)
    const attempt = (orderId: string) =>
      world.prisma.$transaction(async (tx) => {
        await tx.productInventory.findUnique({ where: { productId_outletId: { productId, outletId } } })
        await gate()
        await svc.reserveForOrder(tx, {
          orderId, items: [{ productId, quantity }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId,
        })
      }, TX)

    const settled = await Promise.allSettled(orders.map(attempt))
    return {
      winners: settled.filter((r) => r.status === 'fulfilled').length,
      losers: settled.filter((r) => r.status === 'rejected').length,
      errors: settled.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message ?? r.reason)] : [])),
    }
  }

  // ------------------------------------------------------- INV-002 / 003 ----

  it('INV-002 exactly one of two concurrent reservations wins the last Stok Produk unit', async () => {
    const { productId, outletId, orders } = await fixture(1)

    const { winners, losers, errors } = await race(productId, outletId, orders)

    expect({ winners, losers }).toEqual({ winners: 1, losers: 1 })
    expect(errors.join(' ')).toMatch(/Insufficient available stock/)
    const pi = await expectConsistent(productId, outletId)
    expect(pi.reserved).toBe(1)
  })

  it('INV-003 available Stok Produk never goes negative and reserved never exceeds stock', async () => {
    const { productId, outletId, orders } = await fixture(1, 3)

    const { winners, losers } = await race(productId, outletId, orders)

    expect({ winners, losers }).toEqual({ winners: 1, losers: 2 })

    const pi = await expectConsistent(productId, outletId)
    expect(pi.stock).toBe(1)
    expect(pi.reserved).toBe(1)
  })

  it('INV-002b holds over 10 consecutive races (not timing luck)', async () => {
    const outcomes: Array<{ winners: number; losers: number }> = []
    for (let i = 0; i < 10; i += 1) {
      const { productId, outletId, orders } = await fixture(1)
      const { winners, losers } = await race(productId, outletId, orders)
      outcomes.push({ winners, losers })
      await expectConsistent(productId, outletId)
      expect((await piFor(productId, outletId)).reserved).toBe(1)
    }
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => ({ winners: 1, losers: 1 })))
  }, 180_000)

  it('INV-002c three concurrent reservations against stock=2 yield exactly two winners', async () => {
    const { productId, outletId, orders } = await fixture(2, 3)

    const { winners, losers } = await race(productId, outletId, orders)

    expect({ winners, losers }).toEqual({ winners: 2, losers: 1 })
    expect((await expectConsistent(productId, outletId)).reserved).toBe(2)
  })

  it('INV-002d three concurrent reservations of 2 units against stock=5 never oversell', async () => {
    const { productId, outletId, orders } = await fixture(5, 3)

    const { winners, losers } = await race(productId, outletId, orders, 2)

    expect({ winners, losers }).toEqual({ winners: 2, losers: 1 }) // 2 x 2 = 4 <= 5; a third would need 6
    expect((await expectConsistent(productId, outletId)).reserved).toBe(4)
  })

  // -------------------------------------------------------- sequential -----

  it('INV-004 rejects a quantity larger than the Stok Produk stock', async () => {
    const { productId, outletId, orders } = await fixture(1, 1)
    await expect(reserveTx(orders[0], productId, 2, outletId)).rejects.toThrow(/Insufficient available stock/)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(0)
  })

  it('INV-004b accepts a quantity within Stok Produk stock', async () => {
    const { productId, outletId, orders } = await fixture(5, 1)
    await reserveTx(orders[0], productId, 3, outletId)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(3)
  })

  it('INV-005 rejects any reservation against zero Stok Produk stock (even with master stock)', async () => {
    const { productId, outletId, orders } = await fixture(0, 1)
    await expect(reserveTx(orders[0], productId, 1, outletId)).rejects.toThrow(/Insufficient available stock/)
    await expectConsistent(productId, outletId)
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(0)
  })

  // ------------------------------------------- Stok Produk is the only source --

  it('INV-014 no master-stock fallback: a product WITHOUT a Stok Produk row is refused and nothing is written', async () => {
    const { productId, outletId, orders } = await fixture(0, 1, { inventory: false, master: 100 })

    await expect(reserveTx(orders[0], productId, 1, outletId)).rejects.toThrow(/Insufficient available stock/)

    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(0)
    expect(await world.prisma.productInventory.count({ where: { productId } })).toBe(0)
    expect(await masterStock(productId)).toBe(100)
  })

  it('INV-015 the master stock is ignored in both directions (0 master + Stok Produk 3; 100 master + Stok Produk 1)', async () => {
    const low = await fixture(3, 2, { master: 0 })
    await reserveTx(low.orders[0], low.productId, 3, low.outletId)
    await expect(reserveTx(low.orders[1], low.productId, 1, low.outletId)).rejects.toThrow(/Insufficient available stock/)
    expect((await piFor(low.productId, low.outletId)).reserved).toBe(3)
    expect(await masterStock(low.productId)).toBe(0)

    const high = await fixture(1, 2, { master: 100 })
    await reserveTx(high.orders[0], high.productId, 1, high.outletId)
    await expect(reserveTx(high.orders[1], high.productId, 1, high.outletId)).rejects.toThrow(/Insufficient available stock/)
    expect((await piFor(high.productId, high.outletId)).reserved).toBe(1)
    expect(await masterStock(high.productId)).toBe(100)
  })

  // ------------------------------------------------------- row locking -----

  it('INV-016 the ProductInventory row is really locked: a second reservation WAITS for the first to commit, then sees its hold', async () => {
    const { productId, outletId, orders } = await fixture(1)
    const timeline: string[] = []
    let releaseFirst!: () => void
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve))
    let firstReserved!: () => void
    const firstHasLock = new Promise<void>((resolve) => (firstReserved = resolve))

    const first = world.prisma.$transaction(async (tx) => {
      await svc.reserveForOrder(tx, { orderId: orders[0], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId })
      timeline.push('A reserved (row lock held)')
      firstReserved()
      await firstMayCommit
      timeline.push('A committing')
    }, TX).then(() => timeline.push('A committed'))

    await firstHasLock
    const second = reserveTx(orders[1], productId, 1, outletId)
      .then(() => timeline.push('B reserved'))
      .catch((err: Error) => timeline.push(`B refused: ${err.message}`))

    // Give B ample time: if the row were NOT locked, B would finish (or fail) now.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    timeline.push('after 1.5s wait')
    releaseFirst()
    await Promise.all([first, second])

    // B was still blocked on A's FOR UPDATE lock after 1.5s: nothing from B before A committed...
    expect(timeline.slice(0, 3)).toEqual(['A reserved (row lock held)', 'after 1.5s wait', 'A committing'])
    // ...and once the lock was released, B saw A's committed hold and was refused.
    expect(timeline.slice(3).sort()).toEqual(['A committed', 'B refused: Insufficient available stock'])
    expect((await expectConsistent(productId, outletId)).reserved).toBe(1)
  })

  // -------------------------------------------------------- lifecycle ------

  it('INV-006 releasing a reservation returns its quantity to Stok Produk availability', async () => {
    const { productId, outletId, orders } = await fixture(1, 2)
    await reserveTx(orders[0], productId, 1, outletId)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(1)

    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, orders[0]), TX)

    expect((await expectConsistent(productId, outletId)).reserved).toBe(0)
    // The freed unit is genuinely reservable again.
    await reserveTx(orders[1], productId, 1, outletId)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(1)
  })

  it('INV-007 expiring a reservation returns its quantity to Stok Produk availability (CAS, no double count)', async () => {
    const { productId, outletId, orders } = await fixture(1, 2)
    await reserveTx(orders[0], productId, 1, outletId)
    const row = await world.prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: orders[0] } })

    expect(await svc.expireReservation(row.id)).toBe(true)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(0)
    // Expiry is a CAS: a second attempt must not double-count.
    expect(await svc.expireReservation(row.id)).toBe(false)
    expect((await expectConsistent(productId, outletId)).reserved).toBe(0)
  })

  it('INV-008 committing a reservation deducts Stok Produk stock exactly once and clears the hold', async () => {
    const { productId, outletId, orders } = await fixture(3, 1)
    await reserveTx(orders[0], productId, 2, outletId)

    const committed = await world.prisma.$transaction((tx) => svc.commitForOrder(tx, orders[0]), TX)
    const again = await world.prisma.$transaction((tx) => svc.commitForOrder(tx, orders[0]), TX)

    expect(committed).toBe(1)
    expect(again).toBe(0)
    const pi = await expectConsistent(productId, outletId)
    expect(pi.stock).toBe(1) // 3 - 2, once
    expect(pi.reserved).toBe(0)
  })

  // ------------------------------------------------------- multi-outlet ----

  it('INV-009 a race at one outlet never touches another outlet holding the same product', async () => {
    const { productId, outletId, orders } = await fixture(1)
    const other = await newOutlet('O')
    await world.prisma.productInventory.create({ data: { productId, outletId: other.id, stock: 5, reserved: 0, available: 5 } })

    const { winners, losers } = await race(productId, outletId, orders)

    expect({ winners, losers }).toEqual({ winners: 1, losers: 1 })
    expect((await piFor(productId, outletId)).reserved).toBe(1)
    expect(await piFor(productId, other.id)).toMatchObject({ stock: 5, reserved: 0, available: 5 })
  })

  it('INV-010 outlets hold stock independently — both can sell their own last unit', async () => {
    const { productId, orders } = await fixture(0, 2, { inventory: false })
    const a = await newOutlet('A')
    const b = await newOutlet('B')
    for (const o of [a, b]) {
      await world.prisma.productInventory.create({ data: { productId, outletId: o.id, stock: 1, reserved: 0, available: 1 } })
    }

    const gate = barrier(2)
    const attempt = (orderId: string, outletId: string) =>
      world.prisma.$transaction(async (tx) => {
        await tx.productInventory.findUnique({ where: { productId_outletId: { productId, outletId } } })
        await gate()
        await svc.reserveForOrder(tx, {
          orderId, items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId,
        })
      }, TX)

    const settled = await Promise.allSettled([attempt(orders[0], a.id), attempt(orders[1], b.id)])

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    for (const o of [a, b]) {
      expect((await piFor(productId, o.id)).reserved).toBe(1)
    }
  })

  // ---------------------------------------------------------- deadlock -----

  it('INV-011 reversed multi-product carts at one outlet do not deadlock', async () => {
    const one = await fixture(50, 2)
    const two = await fixture(50, 0, { outletId: one.outletId }) // same outlet: one cart, one fulfilling outlet
    const [p1, p2] = [one.productId, two.productId]

    const gate = barrier(2)
    const attempt = (orderId: string, items: Array<{ productId: string; quantity: number }>) =>
      world.prisma.$transaction(async (tx) => {
        await tx.productInventory.findUnique({ where: { productId_outletId: { productId: items[0].productId, outletId: one.outletId } } })
        await gate()
        await svc.reserveForOrder(tx, { orderId, items, paymentMethod: PaymentMethod.BANK_TRANSFER, outletId: one.outletId })
      }, TX)

    const settled = await Promise.allSettled([
      attempt(one.orders[0], [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 1 }]),
      attempt(one.orders[1], [{ productId: p2, quantity: 1 }, { productId: p1, quantity: 1 }]),
    ])

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const messages = settled.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message)] : []))
    expect(messages.join(' ')).not.toMatch(/deadlock|lock wait timeout/i)
    expect((await expectConsistent(p1, one.outletId)).reserved).toBe(2)
    expect((await expectConsistent(p2, one.outletId)).reserved).toBe(2)
  })

  // ---------------------------------------------------------- rollback -----

  it('INV-012 a failure after reserving leaves no trace of the reservation', async () => {
    const { productId, outletId, orders } = await fixture(5, 1)

    await expect(
      world.prisma.$transaction(async (tx) => {
        await svc.reserveForOrder(tx, {
          orderId: orders[0], items: [{ productId, quantity: 2 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId,
        })
        throw new Error('checkout blew up after reserving')
      }, TX),
    ).rejects.toThrow('checkout blew up after reserving')

    const pi = await expectConsistent(productId, outletId)
    expect(pi).toMatchObject({ stock: 5, reserved: 0, available: 5 })
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(0)
  })

  it('INV-012b a multi-product cart where one product is short rolls back the products already reserved', async () => {
    const ok = await fixture(5, 1)
    const short = await fixture(0, 0, { outletId: ok.outletId })

    await expect(
      world.prisma.$transaction((tx) =>
        svc.reserveForOrder(tx, {
          orderId: ok.orders[0],
          items: [{ productId: ok.productId, quantity: 1 }, { productId: short.productId, quantity: 1 }],
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          outletId: ok.outletId,
        }), TX),
    ).rejects.toThrow(/Insufficient available stock/)

    expect(await expectConsistent(ok.productId, ok.outletId)).toMatchObject({ stock: 5, reserved: 0 })
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: ok.orders[0] } })).toBe(0)
  })

  // ------------------------------------------------------- idempotency -----

  it('INV-013 reserving the same order twice consumes stock twice (documented behaviour)', async () => {
    // The service holds NO per-order idempotency: it is called once, inside the
    // checkout transaction, and checkout's Idempotency-Key is what prevents a
    // duplicate call. This pins that contract so a future change to either side
    // is a deliberate decision rather than a silent one.
    const { productId, outletId, orders } = await fixture(5, 1)

    await reserveTx(orders[0], productId, 1, outletId)
    await reserveTx(orders[0], productId, 1, outletId)

    expect((await expectConsistent(productId, outletId)).reserved).toBe(2)
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(2)
  })
})
