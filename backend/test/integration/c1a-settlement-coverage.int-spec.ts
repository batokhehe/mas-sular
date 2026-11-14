/**
 * C1-a — prevent settlement without inventory commitment, against real PostgreSQL 16.
 *
 * Exercises the REAL InventoryReservationService, InventoryReservationWorker,
 * PaymentSettlementService, GatewayStatusApplier and IncidentCenterService over the
 * container from ./world. Races start together on a barrier, so both sides have
 * passed their pre-checks before either touches a row; the PAYMENT ROW LOCK then
 * decides the order. Each race is repeated to cover both interleavings.
 *
 * Covers both stock models: legacy Product.stock and per-outlet ProductInventory.
 */
import { IncidentStatus, PaymentMethod, PaymentStatus, ReservationStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { IncidentCenterService } from '../../src/infrastructure/logging/incident-center.service'
import { InventoryCoverageError } from '../../src/modules/inventory/inventory-coverage.error'
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service'
import { InventoryReservationWorker } from '../../src/modules/inventory/inventory-reservation.worker'
import { OrderCancellationService } from '../../src/modules/orders/order-cancellation.service'
import { verifyMidtransStatusResponse } from '../../src/modules/payments/gateway/domain/midtrans-status-verification.util'
import { GatewayStatusApplier } from '../../src/modules/payments/gateway/gateway-status-applier.service'
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service'
import { closeWorld, getWorld, IntegrationWorld } from './world'

const TX = { timeout: 30_000, maxWait: 30_000 }
const ROUNDS = 6
const ADMIN = { kind: 'ADMIN' as const, adminId: 'c1a-admin' }
const SYSTEM = { kind: 'SYSTEM' as const, source: 'c1a-int' }

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

type StockModel = 'legacy' | 'outlet'

describe('C1-a settlement ↔ inventory coverage (PostgreSQL)', () => {
  let world: IntegrationWorld
  let inventory: InventoryReservationService
  let settlement: PaymentSettlementService
  let incidents: IncidentCenterService
  let worker: InventoryReservationWorker
  const paidOrders: string[] = []

  beforeAll(async () => {
    world = await getWorld()
    inventory = new InventoryReservationService(world.prisma)
    settlement = new PaymentSettlementService(world.prisma, undefined, inventory, new OrderCancellationService(inventory))
    const cache = { get: async () => undefined, set: async () => undefined }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    incidents = new IncidentCenterService(world.prisma, cache as any)
    const metrics = { expired: () => undefined, failure: () => undefined }
    const config = { enabled: false, pollIntervalMs: 60_000, initialDelayMs: 0, batchSize: 500, healthLogIntervalMs: 60_000 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker = new InventoryReservationWorker(world.prisma, inventory, metrics as any, config as any)
  }, 300_000) // first boot may include container start + every migration

  // Stop this file's PostgreSQL / RabbitMQ containers and close its connections, so
  // they do not stay alive (and hold the Jest process open) while later files run.
  afterAll(() => closeWorld(), 120_000)

  /**
   * One order, checked out through the REAL reserveForOrder, for `qty` units of
   * one product (two order-item rows for the same product when `split`).
   */
  async function checkout(opts: {
    model: StockModel
    qty?: number
    split?: boolean
    method?: PaymentMethod
    paymentStatus?: PaymentStatus
    stock?: number
  }) {
    const { prisma } = world
    const qty = opts.qty ?? 2
    const stock = opts.stock ?? 10
    const uid = randomUUID().slice(0, 8)
    const category = await prisma.category.create({ data: { name: `c1a-${uid}`, slug: `c1a-${uid}` } })
    const product = await prisma.product.create({
      data: {
        slug: `c1a-${uid}`, sku: `C1A-${uid}`, name: `C1A ${uid}`, description: 'x',
        price: 10_000, imageUrl: '/x.png', stock, categoryId: category.id, status: 'ACTIVE', weightGram: 500,
      },
    })
    let outletId: string | undefined
    if (opts.model === 'outlet') {
      const outlet = await prisma.outlet.create({ data: { name: `C1A-${uid}`, isActive: true } })
      outletId = outlet.id
      await prisma.productInventory.create({ data: { productId: product.id, outletId, stock, reserved: 0, available: stock } })
    }
    const user = await prisma.user.create({ data: { email: `c1a-${uid}@test.local`, name: 'C1A' } })
    const address = await prisma.address.create({
      data: { userId: user.id, label: 'H', recipientName: 'C1A', phone: '6281200000000', fullAddress: 'Jl Test', latitude: 0, longitude: 0 },
    })
    const method = opts.method ?? PaymentMethod.BANK_TRANSFER
    const lines = opts.split ? [qty - 1, 1] : [qty]
    const order = await prisma.order.create({
      data: {
        orderNumber: `C1A-${uid}`, userId: user.id, addressId: address.id, status: 'PENDING',
        subtotal: 10_000 * qty, deliveryFee: 0, totalPrice: 10_000 * qty, paymentMethod: method,
        items: { create: lines.map((quantity) => ({ productId: product.id, productName: product.name, unitPrice: 10_000, quantity })) },
        payment: { create: { method, amount: 10_000 * qty, status: opts.paymentStatus ?? PaymentStatus.PENDING } },
      },
      include: { payment: true },
    })
    await prisma.$transaction((tx) => inventory.reserveForOrder(tx, {
      orderId: order.id,
      items: lines.map((quantity) => ({ productId: product.id, quantity })),
      paymentMethod: method,
      outletId,
    }), TX)
    const reservation = await prisma.inventoryReservation.findFirstOrThrow({ where: { orderId: order.id } })
    return { uid, productId: product.id, outletId, orderId: order.id, paymentId: order.payment!.id, reservationId: reservation.id, qty, stock }
  }

  type Fixture = Awaited<ReturnType<typeof checkout>>

  /** Force the reservation past its deadline (what 24h of waiting would do). */
  const makeDue = (f: Fixture) =>
    world.prisma.inventoryReservation.update({ where: { id: f.reservationId }, data: { expiresAt: new Date(Date.now() - 60_000) } })

  async function stockOf(f: Fixture) {
    if (f.outletId) {
      const pi = await world.prisma.productInventory.findUniqueOrThrow({
        where: { productId_outletId: { productId: f.productId, outletId: f.outletId } },
      })
      return { stock: pi.stock, reserved: pi.reserved, available: pi.available }
    }
    const p = await world.prisma.product.findUniqueOrThrow({ where: { id: f.productId } })
    return { stock: p.stock, reserved: 0, available: p.stock }
  }

  /** Invariant: a PAID payment with reservations has every ordered unit COMMITTED, deducted exactly once. */
  async function expectFullyCommittedOnce(f: Fixture) {
    const payment = await world.prisma.payment.findUniqueOrThrow({ where: { id: f.paymentId } })
    expect(payment.status).toBe(PaymentStatus.PAID)
    const rows = await world.prisma.inventoryReservation.findMany({ where: { orderId: f.orderId } })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.status === ReservationStatus.COMMITTED)).toBe(true)
    expect(rows.reduce((s, r) => s + r.committedQty, 0)).toBe(f.qty)
    const s = await stockOf(f)
    expect(s.stock).toBe(f.stock - f.qty) // exactly once
    expect(s.reserved).toBe(0)
    const history = await world.prisma.inventoryReservationHistory.count({
      where: { reservationId: { in: rows.map((r) => r.id) }, status: ReservationStatus.COMMITTED },
    })
    expect(history).toBe(rows.length)
    paidOrders.push(f.orderId)
  }

  describe.each<StockModel>(['legacy', 'outlet'])('%s stock model', (model) => {
    // ------------------------------------------------------------ H1 --------
    it('H1 regression: an overdue reservation of a WAITING_VERIFICATION payment stays RESERVED; settlement then deducts', async () => {
      const f = await checkout({ model, paymentStatus: PaymentStatus.WAITING_VERIFICATION })
      await makeDue(f)

      await worker.releaseExpired()
      await expect(inventory.expireReservation(f.reservationId)).resolves.toBe(false) // direct call too

      const row = await world.prisma.inventoryReservation.findUniqueOrThrow({ where: { id: f.reservationId } })
      expect(row.status).toBe(ReservationStatus.RESERVED)
      expect(await stockOf(f)).toEqual(model === 'outlet'
        ? { stock: f.stock, reserved: f.qty, available: f.stock - f.qty }
        : { stock: f.stock, reserved: 0, available: f.stock })

      await expect(settlement.settle(f.paymentId, ADMIN)).resolves.toEqual(expect.objectContaining({ result: 'SETTLED' }))
      await expectFullyCommittedOnce(f)
    })

    it('the worker still expires overdue reservations of terminal and orphan orders (safety net)', async () => {
      const failed = await checkout({ model })
      await world.prisma.payment.update({ where: { id: failed.paymentId }, data: { status: PaymentStatus.FAILED } })
      await makeDue(failed)
      const orphan = await checkout({ model })
      await world.prisma.payment.delete({ where: { id: orphan.paymentId } })
      await makeDue(orphan)

      await worker.releaseExpired()

      for (const f of [failed, orphan]) {
        const row = await world.prisma.inventoryReservation.findUniqueOrThrow({ where: { id: f.reservationId } })
        expect(row.status).toBe(ReservationStatus.EXPIRED)
        expect((await stockOf(f)).reserved).toBe(0)
      }
    })

    // ------------------------------------------- reservation expiry vs settle --
    it('reservation expiry racing settlement: always PAID + fully COMMITTED, stock deducted exactly once', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const f = await checkout({ model })
        await makeDue(f)
        const gate = barrier(2)
        const [expired, settled] = await Promise.allSettled([
          (async () => { await gate(); return inventory.expireReservation(f.reservationId) })(),
          (async () => { await gate(); return settlement.settle(f.paymentId, ADMIN) })(),
        ])
        expect(expired).toEqual({ status: 'fulfilled', value: false }) // never wins against a payable/paid payment
        expect(settled.status).toBe('fulfilled')
        await expectFullyCommittedOnce(f)
      }
    })

    // ----------------------------------------------- payment expiry vs settle --
    it('payment expiry racing settlement: exactly one wins and inventory matches the winner', async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const f = await checkout({ model })
        const gate = barrier(2)
        const [expired, settled] = await Promise.allSettled([
          (async () => { await gate(); return settlement.expire(f.paymentId, SYSTEM, 'c1a race') })(),
          (async () => { await gate(); return settlement.settle(f.paymentId, ADMIN) })(),
        ])
        const wins = [expired, settled].filter((r) => r.status === 'fulfilled')
        expect(wins).toHaveLength(1)

        const payment = await world.prisma.payment.findUniqueOrThrow({ where: { id: f.paymentId } })
        if (settled.status === 'fulfilled') {
          await expectFullyCommittedOnce(f)
        } else {
          expect(payment.status).toBe(PaymentStatus.EXPIRED)
          const rows = await world.prisma.inventoryReservation.findMany({ where: { orderId: f.orderId } })
          expect(rows.every((r) => r.status === ReservationStatus.EXPIRED)).toBe(true)
          expect(await stockOf(f)).toEqual({ stock: f.stock, reserved: 0, available: f.stock }) // nothing deducted
        }
      }
    })

    // ------------------------------------------------------ B guard ---------
    it('a settlement whose reservation already EXPIRED is refused and fully rolled back', async () => {
      const f = await checkout({ model, split: true, qty: 3 })
      // pre-fix state (H1 already happened): reservation expired, payment still payable
      await world.prisma.payment.update({ where: { id: f.paymentId }, data: { status: PaymentStatus.FAILED } })
      await makeDue(f)
      await worker.releaseExpired()
      await world.prisma.payment.update({ where: { id: f.paymentId }, data: { status: PaymentStatus.PENDING } })
      const before = await stockOf(f)

      await expect(settlement.settle(f.paymentId, ADMIN)).rejects.toBeInstanceOf(InventoryCoverageError)

      const payment = await world.prisma.payment.findUniqueOrThrow({ where: { id: f.paymentId } })
      expect(payment.status).toBe(PaymentStatus.PENDING)
      const order = await world.prisma.order.findUniqueOrThrow({ where: { id: f.orderId } })
      expect(order.status).toBe('PENDING')
      expect(await stockOf(f)).toEqual(before)
      expect(await world.prisma.outboxEvent.count({ where: { aggregateId: f.paymentId, eventName: 'payment.paid' } })).toBe(0)
    })

    // ------------------------------------------------------ incidents -------
    it('a late captured gateway payment yields exactly ONE incident; reconciliation retries do not duplicate it', async () => {
      const f = await checkout({ model, method: PaymentMethod.GATEWAY })
      await world.prisma.payment.update({ where: { id: f.paymentId }, data: { status: PaymentStatus.FAILED } })
      await makeDue(f)
      await worker.releaseExpired()
      await world.prisma.payment.update({ where: { id: f.paymentId }, data: { status: PaymentStatus.PENDING } })

      const providerOrderId = `C1A-${f.uid}`
      const gtx = await world.prisma.paymentGatewayTransaction.create({
        data: { paymentId: f.paymentId, provider: 'midtrans', channelCode: 'qris', providerOrderId, grossAmount: 10_000 * f.qty },
      })
      const v = verifyMidtransStatusResponse({
        order_id: providerOrderId, transaction_status: 'settlement', status_code: '200',
        gross_amount: `${10_000 * f.qty}.00`, transaction_id: `trx-${f.uid}`,
      }, providerOrderId, 10_000 * f.qty)
      if (!v.ok) throw new Error('fixture not verifiable')
      const applier = new GatewayStatusApplier(settlement, undefined, incidents)

      await expect(applier.apply({ transaction: gtx, verified: v, source: 'payments.webhook.midtrans' })).resolves.toBe('illegal_transition')
      // webhook redelivery + reconciliation passes, some concurrent
      await applier.apply({ transaction: gtx, verified: v, source: 'payments.reconciliation.midtrans' })
      await Promise.all([1, 2, 3].map(() => applier.apply({ transaction: gtx, verified: v, source: 'payments.reconciliation.midtrans' })))

      const rows = await world.prisma.incident.findMany({ where: { paymentId: f.paymentId } })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual(expect.objectContaining({
        type: 'payment.settlement_inventory_conflict', status: IncidentStatus.OPEN, orderId: f.orderId, count: 5,
      }))
      expect(JSON.stringify(rows[0].metadata)).not.toMatch(/server.?key|signature|authorization|token|password|secret/i)
      // nothing settled, nothing deducted
      expect((await world.prisma.payment.findUniqueOrThrow({ where: { id: f.paymentId } })).status).toBe(PaymentStatus.PENDING)

      // resolved → a new occurrence opens a new incident
      await world.prisma.incident.update({ where: { id: rows[0].id }, data: { status: IncidentStatus.RESOLVED, resolvedAt: new Date() } })
      await applier.apply({ transaction: gtx, verified: v, source: 'payments.reconciliation.midtrans' })
      const after = await world.prisma.incident.findMany({ where: { paymentId: f.paymentId }, orderBy: { createdAt: 'asc' } })
      expect(after.map((r) => r.status)).toEqual([IncidentStatus.RESOLVED, IncidentStatus.OPEN])
    })
  })

  it('concurrent recordPaymentException calls for one payment create exactly one incident (advisory lock)', async () => {
    const paymentId = randomUUID()
    const input = {
      type: 'payment.captured_not_settled' as const, paymentId, severity: 'HIGH' as const,
      title: 't', description: 'd', source: 'c1a-int',
    }
    await Promise.all(Array.from({ length: 8 }, () => incidents.recordPaymentException(input)))
    const rows = await world.prisma.incident.findMany({ where: { paymentId } })
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(8)
  })

  it('global invariant: every PAID payment produced here has all required quantities COMMITTED', async () => {
    expect(paidOrders.length).toBeGreaterThan(0)
    for (const orderId of paidOrders) {
      const items = await world.prisma.orderItem.findMany({ where: { orderId } })
      const rows = await world.prisma.inventoryReservation.findMany({ where: { orderId, status: ReservationStatus.COMMITTED } })
      expect(rows.reduce((s, r) => s + r.committedQty, 0)).toBe(items.reduce((s, i) => s + i.quantity, 0))
    }
  })
})
