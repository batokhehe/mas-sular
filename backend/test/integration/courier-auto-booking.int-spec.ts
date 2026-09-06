/**
 * PAXELBOX-61AG.3.31 / .3.32 — automatic courier booking after payment settlement.
 *
 * Drives the REAL PaymentSettlementService.settle() against real MySQL, for both
 * manual-receipt payment methods and BOTH couriers, and asserts the whole chain
 * through to the persisted airwaybill and the shipped notification. Only the
 * courier HTTP call is stubbed — the provider factory hands back a stub, so no
 * Paxel/JNE request leaves the process.
 *
 * 3.31 enabled JNE and left Paxel BLOCKED: Paxel's API genuinely requires
 * `pickup_datetime` and nothing in the application could produce one. 3.32 adds
 * the business's global rule (verified at or before 17:00 WIB -> today 19:00,
 * after -> tomorrow 19:00), so Paxel now books automatically too. The exact
 * arithmetic of that rule is pinned by test/unit/paxel-pickup-scheduler.spec.ts;
 * what these tests prove is the WIRING — that a slot is resolved from the
 * authoritative settlement timestamp, persisted, and reaches the courier.
 */
import { OrderStatus, PaymentMethod, PaymentStatus, ShipmentStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service'
import { ShipmentService, AWAITING_PICKUP_SCHEDULE } from '../../src/modules/shipment/shipment.service'
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler'
import { formatPaxelDatetime } from '../../src/modules/shipment/infrastructure/providers/paxel-datetime'
import { readPickupDatetime } from '../../src/modules/shipment/shipment-metadata'
import type { PaxelAutoPickupConfig, ShippingConfig } from '../../src/modules/shipping/shipping.config'
import { getWorld, IntegrationWorld } from './world'

const CUSTOMER_PHONE = '628123456789'

/** The confirmed business policy (61AG.3.32). */
const POLICY: PaxelAutoPickupConfig = {
  enabled: true,
  timeZone: 'Asia/Jakarta',
  cutoffTime: '17:00',
  pickupTime: '19:00',
}

const schedulerWith = (autoPickup: PaxelAutoPickupConfig | undefined) =>
  new PaxelPickupScheduler({ paxel: { autoPickup } } as unknown as ShippingConfig)

describe('automatic courier booking on settlement (real DB, stubbed courier)', () => {
  let world: IntegrationWorld

  beforeAll(async () => {
    world = await getWorld()
  })

  async function ensureOutlet() {
    const found = await world.prisma.outlet.findFirst({ where: { isActive: true, postalCode: { not: null } } })
    return found ?? world.prisma.outlet.create({
      data: { name: 'Origin', isActive: true, postalCode: '40286', latitude: -6.9, longitude: 107.6, addressDetail: 'Jl Origin' },
    })
  }

  /** A paid-pending order with a RATE_SELECTED shipment, exactly as checkout leaves it. */
  async function seed(method: PaymentMethod, provider: string, service: string) {
    await ensureOutlet()
    const uid = randomUUID().slice(0, 8)
    const cat = await world.prisma.category.create({ data: { name: `cb-${uid}`, slug: `cb-${uid}` } })
    const product = await world.prisma.product.create({
      data: { slug: `cb-${uid}`, sku: `CB-${uid}`, name: 'Bakso', description: 'x', price: 30000, imageUrl: '/x.png', stock: 10, categoryId: cat.id, weightGram: 800 },
    })
    const user = await world.prisma.user.create({ data: { email: `cb-${uid}@test.local`, name: 'Budi' } })
    const address = await world.prisma.address.create({
      data: { userId: user.id, label: 'H', recipientName: 'Budi', phone: CUSTOMER_PHONE, fullAddress: 'Jl Test', postalCode: '40111', latitude: 0, longitude: 0 },
    })
    const order = await world.prisma.order.create({
      data: {
        orderNumber: `CB-${uid}`, userId: user.id, addressId: address.id,
        subtotal: 30000, deliveryFee: 10000, totalPrice: 40000,
        paymentMethod: method, status: OrderStatus.PENDING,
        shippingProvider: provider, shippingService: service, shippingServiceName: `${service} Label`,
        items: { create: { productId: product.id, productName: product.name, unitPrice: 30000, quantity: 1, weightGram: 800 } },
        payment: { create: { method, amount: 40000, status: PaymentStatus.WAITING_VERIFICATION } },
        shipment: { create: { provider, service, status: ShipmentStatus.RATE_SELECTED, cost: 10000 } },
      },
      include: { payment: true, shipment: true },
    })
    return { order, payment: order.payment! }
  }

  interface CourierStub {
    name: string
    requiresPickupSchedule?: boolean
    supportsAutomaticBooking?: boolean
    createShipment: (input: unknown) => Promise<unknown>
    trackShipment: () => Promise<unknown>
  }

  /** Settlement wired to a real ShipmentService whose courier is a stub. */
  function settlementWith(
    providerName: string,
    awb: string,
    opts: { autoPickup?: PaxelAutoPickupConfig; failWith?: string } = {},
  ) {
    const calls: Array<{ pickupAtIso?: string }> = []
    const courier: CourierStub = {
      name: providerName,
      // Mirrors the real providers' capability declarations. Paxel's API needs a
      // real appointment; the flag is NOT removed by 3.32, only satisfied.
      requiresPickupSchedule: providerName === 'paxel',
      supportsAutomaticBooking: true,
      createShipment: async (input: unknown) => {
        calls.push(input as { pickupAtIso?: string })
        if (opts.failWith) throw new Error(opts.failWith)
        return { status: ShipmentStatus.CREATED, trackingNumber: awb, providerShipmentId: awb, rawPayload: { ok: true } }
      },
      trackShipment: async () => ({ status: ShipmentStatus.IN_TRANSIT, rawPayload: {} }),
    }
    const shipments = new ShipmentService(
      world.prisma as never,
      { get: () => courier } as never,
      undefined,
      schedulerWith('autoPickup' in opts ? opts.autoPickup : POLICY),
    )
    const settlement = new PaymentSettlementService(world.prisma as never, shipments)
    return { settlement, shipments, calls: () => calls }
  }

  const shipmentOf = (orderId: string) => world.prisma.shipment.findUniqueOrThrow({ where: { orderId } })
  const orderOf = (orderId: string) => world.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const paymentOf = (orderId: string) => world.prisma.payment.findFirstOrThrow({ where: { orderId } })
  const shippedRows = (orderId: string) =>
    world.prisma.notificationOutbox.findMany({
      where: { template: 'order.shipped', payload: { path: '$.orderId', equals: orderId } },
    })

  // ------------------------------------------------------------- the matrix --

  describe.each([
    [PaymentMethod.BANK_TRANSFER, 'jne', 'REG', 'JNE0011223344', 'JNE'],
    [PaymentMethod.QRIS, 'jne', 'REG', 'JNE0055667788', 'JNE'],
    [PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY', 'PXL0011223344', 'PAXEL'],
    [PaymentMethod.QRIS, 'paxel', 'PAXEL_NEXTDAY', 'PXL0055667788', 'PAXEL'],
  ])('%s × %s', (method, provider, service, awb, courier) => {
    it('settles the payment and books the courier automatically', async () => {
      const { order, payment } = await seed(method, provider, service)
      const { settlement, calls } = settlementWith(provider, awb)

      const result = await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'admin-1', note: null })

      // Payment + order transition (unchanged contract). The payment method has no
      // influence on booking whatsoever — only the courier does.
      expect(result.result).toBe('SETTLED')
      expect(result.payment.status).toBe(PaymentStatus.PAID)

      // The courier really was called, exactly once.
      expect(calls()).toHaveLength(1)

      // AWB persisted and the shipment advanced past RATE_SELECTED.
      const shipment = await shipmentOf(order.id)
      expect(shipment.trackingNumber).toBe(awb)
      expect(shipment.providerShipmentId).toBe(awb)
      expect(shipment.status).not.toBe(ShipmentStatus.RATE_SELECTED)

      // Order reached SHIPPED through the legal-transition CAS.
      expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)

      // Exactly one shipped notification, carrying the courier alone and the AWB.
      const rows = await shippedRows(order.id)
      expect(rows).toHaveLength(1)
      const payload = rows[0].payload as Record<string, unknown>
      expect(payload.trackingNumber).toBe(awb)
      expect(String(payload.shippingProvider).toUpperCase()).toBe(courier)
      expect(rows[0].recipient).toBe(CUSTOMER_PHONE)
    })
  })

  // ------------------------------------------------ the Paxel pickup slot ----

  describe('the automatic Paxel pickup appointment', () => {
    it('is resolved, persisted, and reaches the courier as a 19:00 Jakarta slot', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY')
      const { settlement, calls } = settlementWith('paxel', 'PXL-SLOT-1')

      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      const sent = calls()[0].pickupAtIso as string
      expect(sent).toBeTruthy()

      // Persisted on the shipment, and it is the SAME instant that was sent —
      // so a later retry books the appointment already committed to, not a new
      // one computed against a later clock.
      const shipment = await shipmentOf(order.id)
      expect(readPickupDatetime(shipment.metadata)).toBe(sent)

      // The rule, end to end: whatever calendar day it lands on, the appointment
      // is 19:00 Jakarta wall-clock. This is what Paxel receives on the wire.
      expect(formatPaxelDatetime(sent)).toMatch(/^\d{4}-\d{2}-\d{2} 19:00:00$/)

      // And it is a real future appointment relative to the settlement.
      const settled = await paymentOf(order.id)
      expect(new Date(sent).getTime()).toBeGreaterThan(settled.verifiedAt!.getTime())
    })

    /**
     * Deterministic, exact assertions on BOTH sides of the cutoff.
     *
     * settle() stamps verifiedAt from the wall clock, so the matrix above can
     * only assert properties. Here the settlement timestamp is pinned in the
     * database first and the REAL ShipmentService is then driven directly, which
     * makes the expected appointment an exact literal.
     */
    it.each([
      // verified 16:59 WIB -> the SAME day at 19:00 WIB (12:00Z)
      ['at 16:59 WIB, before the cutoff', '2026-09-05T09:59:00.000Z', '2026-09-05T12:00:00.000Z'],
      // verified exactly 17:00 WIB -> still the same day; the cutoff is inclusive
      ['at exactly 17:00 WIB', '2026-09-05T10:00:00.000Z', '2026-09-05T12:00:00.000Z'],
      // verified 17:01 WIB -> the NEXT day at 19:00 WIB
      ['at 17:01 WIB, after the cutoff', '2026-09-05T10:01:00.000Z', '2026-09-06T12:00:00.000Z'],
      // verified 23:59 WIB -> next calendar day, across the month boundary
      ['at 23:59 WIB on the last day of a month', '2026-08-31T16:59:00.000Z', '2026-09-01T12:00:00.000Z'],
    ])('books %s', async (_label, verifiedAtIso, expectedPickupIso) => {
      const { order, payment } = await seed(PaymentMethod.QRIS, 'paxel', 'PAXEL_NEXTDAY')
      const { shipments, calls } = settlementWith('paxel', 'PXL-EXACT-1')

      // The state settlement leaves behind, with the authoritative timestamp
      // PINNED rather than taken from the wall clock — so the expected
      // appointment is an exact literal instead of a property.
      await world.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PAID, verifiedAt: new Date(verifiedAtIso) },
      })
      await world.prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.PROCESSING },
      })
      await shipments.createForOrderSafe(order.id)

      expect(calls()).toHaveLength(1)
      expect(calls()[0].pickupAtIso).toBe(expectedPickupIso)
      expect(readPickupDatetime((await shipmentOf(order.id)).metadata)).toBe(expectedPickupIso)
    })

    it('PRESERVES an explicit pickup time an admin already chose', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY')
      // An admin scheduled 10:00 WIB on a specific day through the packing flow.
      const explicit = '2026-08-24T03:00:00.000Z'
      await world.prisma.shipment.update({
        where: { orderId: order.id },
        data: { metadata: { paxel: { pickupDatetime: explicit } } },
      })

      const { settlement, calls } = settlementWith('paxel', 'PXL-EXPLICIT-1')
      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // The human's appointment is sent verbatim and never recomputed.
      expect(calls()[0].pickupAtIso).toBe(explicit)
      expect(formatPaxelDatetime(calls()[0].pickupAtIso as string)).toBe('2026-08-24 10:00:00')
      expect(readPickupDatetime((await shipmentOf(order.id)).metadata)).toBe(explicit)
      expect((await shipmentOf(order.id)).trackingNumber).toBe('PXL-EXPLICIT-1')
    })
  })

  // ----------------------------------------------------------- feature flag --

  describe('PAXEL_AUTO_PICKUP_ENABLED', () => {
    it('OFF: no slot is invented and the pre-3.32 behaviour is preserved exactly', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY')
      const { settlement, calls } = settlementWith('paxel', 'PXL-OFF-1', {
        autoPickup: { ...POLICY, enabled: false },
      })

      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // No courier call, no schedule written, and — crucially — the row is left
      // alone rather than FAILED, so the admin packing flow can still book it.
      expect(calls()).toHaveLength(0)
      const shipment = await shipmentOf(order.id)
      expect(shipment.status).toBe(ShipmentStatus.RATE_SELECTED)
      expect(shipment.trackingNumber).toBeNull()
      expect(readPickupDatetime(shipment.metadata)).toBeUndefined()
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PROCESSING)
      expect(await shippedRows(order.id)).toHaveLength(0)
    })

    it('UNCONFIGURED: an absent policy means OFF, never an invented appointment', async () => {
      const { order, payment } = await seed(PaymentMethod.QRIS, 'paxel', 'PAXEL_NEXTDAY')
      const { settlement, shipments, calls } = settlementWith('paxel', 'PXL-UNSET-1', { autoPickup: undefined })

      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      expect(calls()).toHaveLength(0)
      expect((await shipmentOf(order.id)).status).toBe(ShipmentStatus.RATE_SELECTED)
      // The reconciliation worker distinguishes this from a failure by the message.
      const outcome = await shipments.createForOrder(order.id)
      expect(outcome).toMatchObject({ ok: false, error: AWAITING_PICKUP_SCHEDULE })
    })

    it('ON: JNE is unaffected by the Paxel pickup policy either way', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'jne', 'REG')
      const { settlement, calls } = settlementWith('jne', 'JNE-NOPICKUP-1', {
        autoPickup: { ...POLICY, enabled: false },
      })

      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // JNE declares no pickup requirement, so it books regardless — and carries
      // no pickup slot into the courier payload.
      expect(calls()).toHaveLength(1)
      expect(calls()[0].pickupAtIso).toBeUndefined()
      expect((await shipmentOf(order.id)).trackingNumber).toBe('JNE-NOPICKUP-1')
    })
  })

  // ------------------------------------------------------------ idempotency --

  describe.each([
    ['jne', 'REG'],
    ['paxel', 'PAXEL_NEXTDAY'],
  ])('%s idempotency', (provider, service) => {
    it('a replayed settlement neither re-books nor duplicates the notification', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, provider, service)
      const awb = `${provider}-REPLAY-1`
      const { settlement, calls } = settlementWith(provider, awb)

      const first = await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })
      const second = await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      expect(first.result).toBe('SETTLED')
      expect(second.result).toBe('ALREADY_PAID')
      expect(calls()).toHaveLength(1)                       // one courier booking
      expect(await shippedRows(order.id)).toHaveLength(1)   // one notification
      expect((await shipmentOf(order.id)).trackingNumber).toBe(awb)
    })

    it('two concurrent booking attempts produce exactly one courier call', async () => {
      const { order, payment } = await seed(PaymentMethod.QRIS, provider, service)
      const awb = `${provider}-RACE-1`
      const { settlement, shipments, calls } = settlementWith(provider, awb)
      await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })
      expect(calls()).toHaveLength(1)

      // A second booker arriving after the AWB exists must short-circuit.
      const again = await shipments.createForOrderSafe(order.id)

      expect(again.ok).toBe(true)
      expect(calls()).toHaveLength(1)
      expect(await shippedRows(order.id)).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------- failure --

  describe.each([
    ['jne', 'REG', 'JNE did not return a cnote (upstream down)', 'cnote'],
    ['paxel', 'PAXEL_NEXTDAY', 'Paxel create response has no airwaybill_code', 'airwaybill'],
  ])('%s failure', (provider, service, message, fragment) => {
    it('leaves the shipment FAILED, retryable, with no notification', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, provider, service)
      const { settlement } = settlementWith(provider, 'unused', { failWith: message })

      const result = await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // The payment still settles — booking is best-effort, outside its transaction.
      expect(result.result).toBe('SETTLED')
      expect(result.payment.status).toBe(PaymentStatus.PAID)

      const shipment = await shipmentOf(order.id)
      expect(shipment.status).toBe(ShipmentStatus.FAILED)
      expect(shipment.trackingNumber).toBeNull()
      const meta = shipment.metadata as Record<string, unknown>
      expect(String(meta.error)).toContain(fragment)        // diagnostics preserved
      expect(await shippedRows(order.id)).toHaveLength(0)   // nothing announced

      // The pickup slot resolved before the failed attempt SURVIVES the FAILED
      // write, so the retry books the appointment already committed to.
      const scheduled = readPickupDatetime(shipment.metadata)
      if (provider === 'paxel') expect(scheduled).toBeTruthy()

      // And a retry can still succeed afterwards.
      const { shipments: retryOk, calls: retryCalls } = settlementWith(provider, `${provider}-RETRY-1`)
      const retry = await retryOk.createForOrderSafe(order.id)

      expect(retry.ok).toBe(true)
      expect((await shipmentOf(order.id)).trackingNumber).toBe(`${provider}-RETRY-1`)
      expect(await shippedRows(order.id)).toHaveLength(1)
      if (provider === 'paxel') expect(retryCalls()[0].pickupAtIso).toBe(scheduled)
    })
  })
})
