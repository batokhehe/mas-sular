/**
 * PAXELBOX-61AG.3.25 — BF-017: the last unit of stock must not be sold twice.
 *
 * Exercises the REAL InventoryReservationService against the real MySQL 8.4
 * container from ./world. Nothing about the reservation logic is reimplemented
 * here: a test that re-ran the SQL by hand would prove something about the test,
 * not about the service.
 *
 * The race is made DETERMINISTIC rather than left to timing luck. Both
 * transactions are forced to take their REPEATABLE READ snapshot (a real read of
 * InventoryReservation) and then wait on a barrier, so neither can commit before
 * the other has read. Without that, the outcome depends on how the two
 * connections happen to interleave.
 */
import { PaymentMethod, ReservationStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { getWorld, IntegrationWorld } from './world'

const TX = { timeout: 30_000, maxWait: 30_000 }

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

describe('BF-017 inventory reservation concurrency', () => {
  let world: IntegrationWorld
  let svc: InventoryReservationService

  beforeAll(async () => {
    world = await getWorld()
    svc = new InventoryReservationService(world.prisma)
  })

  /** A product plus `count` orders pointing at it, all disposable. */
  async function fixture(stock: number, count = 2) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const category = await prisma.category.create({ data: { name: `inv-${uid}`, slug: `inv-${uid}` } })
    const product = await prisma.product.create({
      data: {
        slug: `inv-${uid}`, sku: `INV-${uid}`, name: `Inv ${uid}`, description: 'x',
        price: 10_000, imageUrl: '/x.png', stock, categoryId: category.id, status: 'ACTIVE', weightGram: 500,
      },
    })
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
    return { productId: product.id, orders, userId: user.id, uid }
  }

  /** Reserved quantity currently held against a product. */
  async function reservedFor(productId: string) {
    const agg = await world.prisma.inventoryReservation.aggregate({
      where: { productId, status: ReservationStatus.RESERVED },
      _sum: { reservedQty: true },
    })
    return agg._sum.reservedQty ?? 0
  }

  async function stockFor(productId: string) {
    return (await world.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock
  }

  /**
   * Two overlapping reservation transactions for the same product, each taking
   * its snapshot before either is allowed to proceed.
   */
  async function race(productId: string, orders: string[], quantity = 1, outletId?: string) {
    const gate = barrier(orders.length)
    const attempt = (orderId: string) =>
      world.prisma.$transaction(async (tx) => {
        // Establish this transaction's consistent-read snapshot on the very table
        // the availability predicate consults...
        await tx.inventoryReservation.count({ where: { productId } })
        // ...then hold until every participant has done the same.
        await gate()
        await svc.reserveForOrder(tx, {
          orderId,
          items: [{ productId, quantity }],
          paymentMethod: PaymentMethod.BANK_TRANSFER,
          outletId,
        })
      }, TX)

    const settled = await Promise.allSettled(orders.map(attempt))
    return {
      winners: settled.filter((r) => r.status === 'fulfilled').length,
      losers: settled.filter((r) => r.status === 'rejected').length,
      errors: settled.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message ?? r.reason)] : [])),
    }
  }

  // ------------------------------------------------------- INV-001 / 002 ----

  it('INV-002 legacy path: exactly one of two concurrent reservations wins the last unit', async () => {
    const { productId, orders } = await fixture(1)

    const { winners, losers, errors } = await race(productId, orders)

    expect({ winners, losers }).toEqual({ winners: 1, losers: 1 })
    expect(errors.join(' ')).toMatch(/Insufficient available stock/)
    expect(await reservedFor(productId)).toBe(1)
  })

  it('INV-003 legacy path: available stock never goes negative', async () => {
    const { productId, orders } = await fixture(1)

    await race(productId, orders)

    const stock = await stockFor(productId)
    const reserved = await reservedFor(productId)
    expect(stock).toBeGreaterThanOrEqual(0)
    expect(reserved).toBeLessThanOrEqual(stock)
    expect(stock - reserved).toBeGreaterThanOrEqual(0)
  })

  it('INV-002b holds over 10 consecutive races (not timing luck)', async () => {
    const outcomes: Array<{ winners: number; losers: number }> = []
    for (let i = 0; i < 10; i += 1) {
      const { productId, orders } = await fixture(1)
      const { winners, losers } = await race(productId, orders)
      outcomes.push({ winners, losers })
      expect(await reservedFor(productId)).toBeLessThanOrEqual(1)
    }
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => ({ winners: 1, losers: 1 })))
  }, 180_000)

  it('INV-002c three concurrent reservations against stock=2 yield exactly two winners', async () => {
    const { productId, orders } = await fixture(2, 3)

    const { winners, losers } = await race(productId, orders)

    expect({ winners, losers }).toEqual({ winners: 2, losers: 1 })
    expect(await reservedFor(productId)).toBe(2)
  })

  // -------------------------------------------------------- sequential -----

  it('INV-004 rejects a quantity larger than the stock', async () => {
    const { productId, orders } = await fixture(1, 1)
    await expect(
      world.prisma.$transaction((tx) =>
        svc.reserveForOrder(tx, {
          orderId: orders[0], items: [{ productId, quantity: 2 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
        }), TX),
    ).rejects.toThrow(/Insufficient available stock/)
    expect(await reservedFor(productId)).toBe(0)
  })

  it('INV-004b accepts a quantity within stock', async () => {
    const { productId, orders } = await fixture(5, 1)
    await world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, {
        orderId: orders[0], items: [{ productId, quantity: 3 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
      }), TX)
    expect(await reservedFor(productId)).toBe(3)
  })

  it('INV-005 rejects any reservation against zero stock', async () => {
    const { productId, orders } = await fixture(0, 1)
    await expect(
      world.prisma.$transaction((tx) =>
        svc.reserveForOrder(tx, {
          orderId: orders[0], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
        }), TX),
    ).rejects.toThrow(/Insufficient available stock/)
  })

  // -------------------------------------------------------- lifecycle ------

  it('INV-006 releasing a reservation returns its quantity to availability', async () => {
    const { productId, orders } = await fixture(1, 2)
    await world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, {
        orderId: orders[0], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
      }), TX)
    expect(await reservedFor(productId)).toBe(1)

    await world.prisma.$transaction((tx) => svc.releaseForOrder(tx, orders[0]), TX)

    expect(await reservedFor(productId)).toBe(0)
    // The freed unit is genuinely reservable again.
    await world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, {
        orderId: orders[1], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
      }), TX)
    expect(await reservedFor(productId)).toBe(1)
  })

  it('INV-007 expiring a reservation returns its quantity to availability', async () => {
    const { productId, orders } = await fixture(1, 2)
    await world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, {
        orderId: orders[0], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
      }), TX)
    const row = await world.prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: orders[0] } })

    expect(await svc.expireReservation(row.id)).toBe(true)
    expect(await reservedFor(productId)).toBe(0)
    // Expiry is a CAS: a second attempt must not double-count.
    expect(await svc.expireReservation(row.id)).toBe(false)
    expect(await reservedFor(productId)).toBe(0)
  })

  it('INV-008 committing a reservation deducts stock and clears the hold', async () => {
    const { productId, orders } = await fixture(3, 1)
    await world.prisma.$transaction((tx) =>
      svc.reserveForOrder(tx, {
        orderId: orders[0], items: [{ productId, quantity: 2 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
      }), TX)

    const committed = await world.prisma.$transaction((tx) => svc.commitForOrder(tx, orders[0]), TX)

    expect(committed).toBe(1)
    expect(await stockFor(productId)).toBe(1)   // 3 − 2
    expect(await reservedFor(productId)).toBe(0)
  })

  // ------------------------------------------------------- multi-outlet ----

  it('INV-009 multi-outlet path: one winner for the last unit at an outlet', async () => {
    const { productId, orders } = await fixture(1)
    const outlet = await world.prisma.outlet.create({ data: { name: `O-${randomUUID().slice(0, 6)}`, isActive: true } })
    await world.prisma.productInventory.create({
      data: { productId, outletId: outlet.id, stock: 1, reserved: 0, available: 1 },
    })

    const { winners, losers } = await race(productId, orders, 1, outlet.id)

    expect({ winners, losers }).toEqual({ winners: 1, losers: 1 })
    const pi = await world.prisma.productInventory.findUniqueOrThrow({
      where: { productId_outletId: { productId, outletId: outlet.id } },
    })
    expect(pi.reserved).toBe(1)
    expect(pi.stock - pi.reserved).toBeGreaterThanOrEqual(0)
  })

  it('INV-010 outlets hold stock independently — both can sell their own last unit', async () => {
    const { productId, orders } = await fixture(0)   // global stock irrelevant here
    const a = await world.prisma.outlet.create({ data: { name: `A-${randomUUID().slice(0, 6)}`, isActive: true } })
    const b = await world.prisma.outlet.create({ data: { name: `B-${randomUUID().slice(0, 6)}`, isActive: true } })
    for (const o of [a, b]) {
      await world.prisma.productInventory.create({
        data: { productId, outletId: o.id, stock: 1, reserved: 0, available: 1 },
      })
    }

    const gate = barrier(2)
    const attempt = (orderId: string, outletId: string) =>
      world.prisma.$transaction(async (tx) => {
        await tx.inventoryReservation.count({ where: { productId } })
        await gate()
        await svc.reserveForOrder(tx, {
          orderId, items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER, outletId,
        })
      }, TX)

    const settled = await Promise.allSettled([attempt(orders[0], a.id), attempt(orders[1], b.id)])

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    for (const o of [a, b]) {
      const pi = await world.prisma.productInventory.findUniqueOrThrow({
        where: { productId_outletId: { productId, outletId: o.id } },
      })
      expect(pi.reserved).toBe(1)
    }
  })

  // ---------------------------------------------------------- deadlock -----

  it('INV-011 reversed multi-product carts do not deadlock', async () => {
    const one = await fixture(50, 2)
    const two = await fixture(50, 0)
    const [p1, p2] = [one.productId, two.productId]

    const gate = barrier(2)
    const attempt = (orderId: string, items: Array<{ productId: string; quantity: number }>) =>
      world.prisma.$transaction(async (tx) => {
        await tx.inventoryReservation.count({ where: { productId: items[0].productId } })
        await gate()
        await svc.reserveForOrder(tx, { orderId, items, paymentMethod: PaymentMethod.BANK_TRANSFER })
      }, TX)

    const settled = await Promise.allSettled([
      attempt(one.orders[0], [{ productId: p1, quantity: 1 }, { productId: p2, quantity: 1 }]),
      attempt(one.orders[1], [{ productId: p2, quantity: 1 }, { productId: p1, quantity: 1 }]),
    ])

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const messages = settled.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message)] : []))
    expect(messages.join(' ')).not.toMatch(/deadlock|lock wait timeout/i)
  })

  // ---------------------------------------------------------- rollback -----

  it('INV-012 a failure after reserving leaves no trace of the reservation', async () => {
    const { productId, orders } = await fixture(5, 1)

    await expect(
      world.prisma.$transaction(async (tx) => {
        await svc.reserveForOrder(tx, {
          orderId: orders[0], items: [{ productId, quantity: 2 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
        })
        throw new Error('checkout blew up after reserving')
      }, TX),
    ).rejects.toThrow('checkout blew up after reserving')

    expect(await reservedFor(productId)).toBe(0)
    expect(await stockFor(productId)).toBe(5)
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(0)
  })

  // ------------------------------------------------------- idempotency -----

  it('INV-013 reserving the same order twice consumes stock twice (documented behaviour)', async () => {
    // The service holds NO per-order idempotency: it is called once, inside the
    // checkout transaction, and checkout's Idempotency-Key is what prevents a
    // duplicate call. This pins that contract so a future change to either side
    // is a deliberate decision rather than a silent one.
    const { productId, orders } = await fixture(5, 1)
    const reserve = () =>
      world.prisma.$transaction((tx) =>
        svc.reserveForOrder(tx, {
          orderId: orders[0], items: [{ productId, quantity: 1 }], paymentMethod: PaymentMethod.BANK_TRANSFER,
        }), TX)

    await reserve()
    await reserve()

    expect(await reservedFor(productId)).toBe(2)
    expect(await world.prisma.inventoryReservation.count({ where: { orderId: orders[0] } })).toBe(2)
  })
})
