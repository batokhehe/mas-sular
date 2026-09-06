/**
 * PAXELBOX-61AG.3.33 — LOCAL RUNTIME VERIFICATION of automatic courier booking.
 *
 * VERIFICATION ONLY. This file adds no behaviour; it observes the behaviour
 * 61AG.3.32 shipped, one level deeper than that phase's own spec.
 *
 * 3.32 proved the WIRING with stub *providers*. This proves the REQUEST: the
 * real PaxelShipmentProvider and real JneShipmentProvider build the actual
 * courier payload, and only the HTTP transport underneath them is replaced. So
 * `pickup_datetime` asserted here is the literal string that would go on the
 * wire to Paxel, not a domain value that a stub happened to receive.
 *
 * Everything in the chain is the real thing:
 *   PaymentSettlementService.settle -> after-commit createForOrderSafe ->
 *   ShipmentProviderFactory -> PaxelPickupScheduler -> Paxel/JNE provider ->
 *   payload builder -> (stubbed transport) -> AWB persistence -> order CAS ->
 *   NotificationOutbox -> NotificationMessageBuilder -> TemplateRegistry ->
 *   QontakWhatsAppProvider -> (stubbed transport)
 *
 * WHY NOT THE RUNNING BACKEND: the developer's backend/.env points DATABASE_URL
 * at the SHARED DEVELOPMENT database, and booting it would start the tracking
 * worker (SHIPMENT_TRACKING_ENABLED=true) against real courier APIs, the
 * notification sender (NOTIFICATION_SENDER_ENABLED + NOTIFICATION_DELIVERY_ENABLED
 * =true) against real Qontak, and Midtrans reconciliation against the real
 * gateway. Runtime verification therefore runs against disposable MySQL here.
 *
 * CREDENTIALS ARE DELIBERATELY FAKE and the base URLs deliberately unroutable —
 * belt and braces on top of the stubbed transport, so a mistake cannot reach a
 * real courier.
 */
import { NotificationOutbox, OrderStatus, PaymentMethod, PaymentStatus, ShipmentStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { PaymentSettlementService } from '../../src/modules/payments/settlement/payment-settlement.service'
import { ShipmentService } from '../../src/modules/shipment/shipment.service'
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory'
import { PaxelShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/paxel-shipment.provider'
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider'
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler'
import { readPickupDatetime } from '../../src/modules/shipment/shipment-metadata'
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config'
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry'
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder'
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider'
import { getWorld, IntegrationWorld } from './world'

const CUSTOMER_PHONE = '628123456789'
const SHIPPED_TPL = 'SHIPPED-TPL-3-33'

/** Mirrors the developer's .env policy exactly; credentials are fake. */
function shippingConfig(autoPickupEnabled = true): ShippingConfig {
  return {
    originPostalCode: '40111',
    allowMockRates: false,
    rajaongkir: { enabled: false, baseUrl: 'https://rajaongkir.invalid/api/v1', timeoutMs: 1000, maxRetry: 0 },
    paxel: {
      enabled: true,
      baseUrl: 'https://paxel.invalid/v1',
      apiKey: 'fake-key-not-a-real-credential',
      apiSecret: 'fake-secret-not-a-real-credential',
      originPhone: '081212121212',
      originNote: 'gerbang samping, tanya shift lead',
      needInsurance: false,
      timeoutMs: 1000,
      maxRetry: 0,
      defaultDimension: '30x35x20',
      // The four values read from the real backend/.env in Part 1.
      autoPickup: {
        enabled: autoPickupEnabled,
        timeZone: 'Asia/Jakarta',
        cutoffTime: '17:00',
        pickupTime: '19:00',
      },
    },
    jne: {
      enabled: true,
      environment: 'sandbox',
      baseUrl: 'https://jne.invalid',
      apiKey: 'fake-key-not-a-real-credential',
      username: 'fake-user',
      originCode: 'CGK10000',
      timeoutMs: 1000,
      maxRetry: 0,
    },
  }
}

interface Captured { url: string; body: unknown }

/** Replaces ONLY the transport under a real provider; captures what it would send. */
function stubTransport(provider: object, respond: () => unknown, captured: Captured[], fail?: string) {
  ;(provider as { http: unknown }).http = async (url: string, init: { body?: string }) => {
    captured.push({ url, body: init.body ? JSON.parse(safeJson(init.body)) : undefined })
    if (fail) return { status: 500, headers: { get: () => null }, text: async () => fail }
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(respond()) }
  }
}

/** JNE posts form-encoded; Paxel posts JSON. Normalise both to an object. */
function safeJson(body: string): string {
  if (body.trim().startsWith('{')) return body
  const params = new URLSearchParams(body)
  return JSON.stringify(Object.fromEntries(params.entries()))
}

/** The Jakarta calendar date of an instant, computed independently of the resolver. */
function jakartaDate(at: Date): string {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) parts[p.type] = p.value
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** The Jakarta hour:minute of an instant, computed independently of the resolver. */
function jakartaMinutes(at: Date): number {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) parts[p.type] = p.value
  return Number(parts.hour) * 60 + Number(parts.minute)
}

/** The calendar date the business rule says a payment verified at `at` belongs to. */
function expectedPickupDate(at: Date): string {
  if (jakartaMinutes(at) <= 17 * 60) return jakartaDate(at)
  return jakartaDate(new Date(at.getTime() + 24 * 60 * 60 * 1000))
}

describe('61AG.3.33 runtime verification — real couriers, stubbed transport', () => {
  let world: IntegrationWorld
  let registry: TemplateRegistry

  beforeAll(async () => {
    world = await getWorld()
    const saved = process.env.QONTAK_SHIPPED_TEMPLATE_ID
    process.env.QONTAK_SHIPPED_TEMPLATE_ID = SHIPPED_TPL
    registry = new TemplateRegistry()
    if (saved === undefined) delete process.env.QONTAK_SHIPPED_TEMPLATE_ID
    else process.env.QONTAK_SHIPPED_TEMPLATE_ID = saved
  })

  // -------------------------------------------------------------- fixtures --

  /** Master-address rows: Paxel requires province/city/district/village NAMES. */
  async function region(uid: string) {
    const { prisma } = world
    const province = await prisma.province.create({ data: { code: `P${uid}`, name: 'Jawa Barat' } })
    const city = await prisma.city.create({ data: { code: `C${uid}`, name: 'Kota Bandung', provinceId: province.id } })
    const district = await prisma.district.create({ data: { code: `D${uid}`, name: 'Buahbatu', cityId: city.id } })
    const village = await prisma.village.create({ data: { code: `V${uid}`, name: 'Jatisari', districtId: district.id, postalCode: '40286' } })
    return { province, city, district, village }
  }

  async function outletFor(uid: string) {
    const r = await region(`O${uid}`)
    return world.prisma.outlet.create({
      data: {
        name: 'Mas Sular Pusat', isActive: true, postalCode: '40286',
        addressDetail: 'Jl. Origin No. 1', latitude: -6.9, longitude: 107.6,
        provinceId: r.province.id, cityId: r.city.id, districtId: r.district.id, villageId: r.village.id,
      },
    })
  }

  /** A fully Paxel-bookable order, exactly as checkout leaves it. */
  async function seed(method: PaymentMethod, provider: string, service: string) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const outlet = await outletFor(uid)
    const r = await region(uid)
    const cat = await prisma.category.create({ data: { name: `rt-${uid}`, slug: `rt-${uid}` } })
    const product = await prisma.product.create({
      data: { slug: `rt-${uid}`, sku: `RT-${uid}`, name: 'Bakso Urat', description: 'x', price: 30000, imageUrl: '/x.png', stock: 10, categoryId: cat.id, weightGram: 800 },
    })
    const user = await prisma.user.create({ data: { email: `rt-${uid}@test.local`, name: 'Budi Santoso' } })
    const address = await prisma.address.create({
      data: {
        userId: user.id, label: 'Rumah', recipientName: 'Budi Santoso', phone: CUSTOMER_PHONE,
        fullAddress: 'Jl. Tujuan No. 9', addressDetail: 'Jl. Tujuan No. 9', postalCode: '40286',
        latitude: -6.95, longitude: 107.65,
        provinceId: r.province.id, cityId: r.city.id, districtId: r.district.id, villageId: r.village.id,
      },
    })
    const order = await prisma.order.create({
      data: {
        orderNumber: `RT-${uid}`, userId: user.id, addressId: address.id, outletId: outlet.id,
        subtotal: 30000, deliveryFee: 10000, totalPrice: 40000,
        paymentMethod: method, status: OrderStatus.PENDING,
        shippingProvider: provider, shippingService: service, shippingServiceName: `${service} Label`,
        items: {
          create: {
            productId: product.id, productName: product.name, unitPrice: 30000, quantity: 1,
            weightGram: 800, lengthCm: 20, widthCm: 15, heightCm: 10, isFragile: false,
          },
        },
        payment: { create: { method, amount: 40000, status: PaymentStatus.WAITING_VERIFICATION } },
        shipment: { create: { provider, service, status: ShipmentStatus.RATE_SELECTED, cost: 10000 } },
      },
      include: { payment: true },
    })
    return { order, payment: order.payment! }
  }

  /** The real stack, with only the two transports replaced. */
  function stack(opts: { awb?: string; autoPickup?: boolean; failCourier?: boolean } = {}) {
    const config = shippingConfig(opts.autoPickup ?? true)
    const awb = opts.awb ?? 'AWB-DEFAULT'
    const paxelCalls: Captured[] = []
    const jneCalls: Captured[] = []

    const paxel = new PaxelShipmentProvider(config)
    stubTransport(paxel, () => ({ data: { airwaybill_code: awb } }), paxelCalls,
      opts.failCourier ? JSON.stringify({ message: 'paxel upstream unavailable' }) : undefined)

    const jne = new JneShipmentProvider(config)
    stubTransport(jne, () => ({ detail: [{ cnote_no: awb, status: 'SUCCESS' }] }), jneCalls,
      opts.failCourier ? JSON.stringify({ error: 'jne upstream unavailable' }) : undefined)

    const factory = new ShipmentProviderFactory([paxel, jne])
    const shipments = new ShipmentService(
      world.prisma as never, factory as never, undefined, new PaxelPickupScheduler(config),
    )
    const settlement = new PaymentSettlementService(world.prisma as never, shipments)
    return { settlement, shipments, paxelCalls, jneCalls }
  }

  const shipmentOf = (orderId: string) => world.prisma.shipment.findUniqueOrThrow({ where: { orderId } })
  const orderOf = (orderId: string) => world.prisma.order.findUniqueOrThrow({ where: { id: orderId } })
  const paymentOf = (orderId: string) => world.prisma.payment.findFirstOrThrow({ where: { orderId } })
  const shippedRows = (orderId: string) =>
    world.prisma.notificationOutbox.findMany({
      where: { template: 'order.shipped', payload: { path: '$.orderId', equals: orderId } },
    })
  const eventsOf = (orderId: string) =>
    world.prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, select: { status: true } })

  /** Render the persisted notification through the REAL Qontak stack; capture the body. */
  async function renderWhatsApp(row: NotificationOutbox) {
    const builder = new NotificationMessageBuilder(
      { getActiveAccount: async () => null } as never,
      registry,
    )
    const message = await builder.build(row)
    let captured:
      | {
          message_template_id?: string
          to_name?: string
          // Qontak's shape: `value` carries the VARIABLE NAME, `value_text` the content.
          parameters?: { body?: Array<{ key: string; value: string; value_text: string }> }
        }
      | undefined
    const provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 1000, maxRetry: 0 } as never,
      registry as never,
    )
    ;(provider as unknown as { http: unknown }).http = async (_u: string, init: { body?: string }) => {
      captured = JSON.parse(String(init.body))
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: 'q' } }) }
    }
    await provider.send(message)
    return captured!
  }

  // ============================ PARTS 4-7 — the payment x courier matrix =====

  describe.each([
    ['PART 4', PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY', 'PXL-RT-0001', 'PAXEL'],
    ['PART 5', PaymentMethod.QRIS, 'paxel', 'PAXEL_NEXTDAY', 'PXL-RT-0002', 'PAXEL'],
    ['PART 6', PaymentMethod.BANK_TRANSFER, 'jne', 'REG', 'JNE-RT-0001', 'JNE'],
    ['PART 7', PaymentMethod.QRIS, 'jne', 'REG', 'JNE-RT-0002', 'JNE'],
  ])('%s: %s -> %s', (_part, method, providerName, service, awb, courier) => {
    it('books automatically through the real provider and announces it once', async () => {
      const { order, payment } = await seed(method, providerName, service)

      // Precondition (Part 4 §3).
      const before = await shipmentOf(order.id)
      expect(before.status).toBe(ShipmentStatus.RATE_SELECTED)
      expect(before.trackingNumber).toBeNull()
      expect(before.provider).toBe(providerName)

      const { settlement, paxelCalls, jneCalls } = stack({ awb })
      const result = await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'admin-1', note: null })

      // --- payment + order ---
      expect(result.result).toBe('SETTLED')
      expect((await paymentOf(order.id)).status).toBe(PaymentStatus.PAID)
      // PROCESSING was recorded first, then SHIPPED — the legal transition chain.
      expect((await eventsOf(order.id)).map((e) => e.status)).toEqual([OrderStatus.PROCESSING, OrderStatus.SHIPPED])
      expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)

      // --- the courier request that would really have gone out ---
      const calls = providerName === 'paxel' ? paxelCalls : jneCalls
      const other = providerName === 'paxel' ? jneCalls : paxelCalls
      expect(calls).toHaveLength(1)
      expect(other).toHaveLength(0)                       // the other courier is never touched
      expect(calls[0].url).toContain('.invalid')          // never a real courier host

      const body = calls[0].body as Record<string, unknown>
      const shipment = await shipmentOf(order.id)

      if (providerName === 'paxel') {
        // Part 4/5: pickup_datetime exists and follows the business rule.
        const verifiedAt = (await paymentOf(order.id)).verifiedAt!
        expect(body.pickup_datetime).toBe(`${expectedPickupDate(verifiedAt)} 19:00:00`)
        expect(body.invoice_number).toBe(order.orderNumber)
        expect(body.service_type).toBe('NEXTDAY')
        // The instant sent is exactly the one persisted on the shipment.
        expect(readPickupDatetime(shipment.metadata)).toBeTruthy()
      } else {
        // Part 6/7: the JNE booking really happened — no manual AWB anywhere.
        expect(body.order_no).toBe(order.orderNumber)
        expect(body.service_code).toBe(service)
        expect(body.origin_code).toBe('CGK10000')
        expect(body.pickup_datetime).toBeUndefined()
      }

      // --- AWB persisted ---
      expect(shipment.trackingNumber).toBe(awb)
      expect(shipment.providerShipmentId).toBe(awb)
      expect(shipment.status).toBe(ShipmentStatus.CREATED)
      expect((await orderOf(order.id)).trackingNumber).toBe(awb)

      // --- exactly one notification, with the real rendered Qontak payload ---
      const rows = await shippedRows(order.id)
      expect(rows).toHaveLength(1)
      const sent = await renderWhatsApp(rows[0])
      expect(sent.message_template_id).toBe(SHIPPED_TPL)
      expect(sent.parameters?.body).toEqual([
        { key: '1', value: 'customer_name', value_text: 'Budi Santoso' },
        { key: '2', value: 'order_no', value_text: order.orderNumber },
        { key: '3', value: 'courier', value_text: courier },
        { key: '4', value: 'tracking', value_text: awb },
      ])
      // The service code and its label must not leak into the customer message.
      expect(JSON.stringify(sent)).not.toContain(service === 'REG' ? 'REG Label' : 'PAXEL_NEXTDAY')
    })
  })

  // ================================== PART 8 — the cutoff matrix, on the wire =

  describe('PART 8: the exact pickup_datetime Paxel would receive', () => {
    it.each([
      ['08:00', '2026-09-05T01:00:00.000Z', '2026-09-05 19:00:00'],
      ['16:59', '2026-09-05T09:59:00.000Z', '2026-09-05 19:00:00'],
      ['17:00', '2026-09-05T10:00:00.000Z', '2026-09-05 19:00:00'],
      ['17:01', '2026-09-05T10:01:00.000Z', '2026-09-06 19:00:00'],
      ['22:00', '2026-09-05T15:00:00.000Z', '2026-09-06 19:00:00'],
    ])('verified at %s WIB -> %s', async (_label, verifiedAtIso, expectedWire) => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_SAMEDAY')
      const { shipments, paxelCalls } = stack({ awb: 'PXL-CUTOFF' })

      // The state settlement leaves behind, with the authoritative timestamp
      // PINNED — no waiting on the real clock (Part 8).
      await world.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.PAID, verifiedAt: new Date(verifiedAtIso) },
      })
      await world.prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } })

      const outcome = await shipments.createForOrderSafe(order.id)

      expect(outcome.ok).toBe(true)
      expect(paxelCalls).toHaveLength(1)
      expect((paxelCalls[0].body as Record<string, unknown>).pickup_datetime).toBe(expectedWire)
    })
  })

  // ============================== PART 10 — explicit override is not touched ==

  it('PART 10: an explicit pickup time reaches Paxel verbatim and is not recomputed', async () => {
    const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_INSTANT')
    const explicit = '2026-08-24T03:00:00.000Z' // 10:00 WIB
    await world.prisma.shipment.update({
      where: { orderId: order.id },
      data: { metadata: { paxel: { pickupDatetime: explicit } } },
    })

    const { settlement, paxelCalls } = stack({ awb: 'PXL-EXPLICIT' })
    await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

    expect((paxelCalls[0].body as Record<string, unknown>).pickup_datetime).toBe('2026-08-24 10:00:00')
    expect(readPickupDatetime((await shipmentOf(order.id)).metadata)).toBe(explicit)
    expect((await shipmentOf(order.id)).trackingNumber).toBe('PXL-EXPLICIT')
    expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)
    expect(await shippedRows(order.id)).toHaveLength(1)
  })

  // ================================================= PART 11 — failure/retry ==

  describe.each([
    ['paxel', 'PAXEL_NEXTDAY'],
    ['jne', 'REG'],
  ])('PART 11: %s failure then retry', (providerName, service) => {
    it('fails safely, then a retry books exactly once', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, providerName, service)
      const failing = stack({ failCourier: true })

      const result = await failing.settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // Payment survives; booking is best-effort and outside its transaction.
      expect(result.result).toBe('SETTLED')
      expect((await paymentOf(order.id)).status).toBe(PaymentStatus.PAID)
      const failed = await shipmentOf(order.id)
      expect(failed.status).toBe(ShipmentStatus.FAILED)
      expect(failed.trackingNumber).toBeNull()
      expect((await orderOf(order.id)).status).toBe(OrderStatus.PROCESSING) // never a false SHIPPED
      expect(await shippedRows(order.id)).toHaveLength(0)                   // and nothing announced

      // Retry through the real provider again.
      const retry = stack({ awb: `${providerName}-RETRY` })
      const outcome = await retry.shipments.createForOrderSafe(order.id)

      expect(outcome.ok).toBe(true)
      expect((await shipmentOf(order.id)).trackingNumber).toBe(`${providerName}-RETRY`)
      expect((await orderOf(order.id)).status).toBe(OrderStatus.SHIPPED)
      expect(await shippedRows(order.id)).toHaveLength(1)
    })
  })

  // ======================================== PART 12 — duplicate / concurrency =

  describe.each([
    ['paxel', 'PAXEL_NEXTDAY'],
    ['jne', 'REG'],
  ])('PART 12: %s idempotency', (providerName, service) => {
    it('a replayed settlement books once and announces once', async () => {
      const { order, payment } = await seed(PaymentMethod.QRIS, providerName, service)
      const s = stack({ awb: `${providerName}-REPLAY` })

      const first = await s.settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })
      const second = await s.settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      expect(first.result).toBe('SETTLED')
      expect(second.result).toBe('ALREADY_PAID')
      expect(s.paxelCalls.length + s.jneCalls.length).toBe(1)
      expect(await shippedRows(order.id)).toHaveLength(1)
    })

    it('concurrent booking attempts produce exactly one courier request', async () => {
      const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, providerName, service)
      const s = stack({ awb: `${providerName}-RACE` })
      await s.settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

      // Three more bookers arriving at once, through the same real stack.
      const again = await Promise.all([
        s.shipments.createForOrderSafe(order.id),
        s.shipments.createForOrderSafe(order.id),
        s.shipments.createForOrderSafe(order.id),
      ])

      expect(again.every((o) => o.ok)).toBe(true)
      expect(s.paxelCalls.length + s.jneCalls.length).toBe(1)
      expect(await shippedRows(order.id)).toHaveLength(1)
      expect((await shipmentOf(order.id)).trackingNumber).toBe(`${providerName}-RACE`)
    })
  })

  // ========================================== the feature flag, at this level =

  it('PAXEL_AUTO_PICKUP_ENABLED=false leaves Paxel unbooked and untouched', async () => {
    const { order, payment } = await seed(PaymentMethod.BANK_TRANSFER, 'paxel', 'PAXEL_NEXTDAY')
    const { settlement, paxelCalls } = stack({ autoPickup: false })

    await settlement.settle(payment.id, { kind: 'ADMIN', adminId: 'a', note: null })

    expect(paxelCalls).toHaveLength(0)
    const shipment = await shipmentOf(order.id)
    expect(shipment.status).toBe(ShipmentStatus.RATE_SELECTED)
    expect(readPickupDatetime(shipment.metadata)).toBeUndefined()
    expect((await orderOf(order.id)).status).toBe(OrderStatus.PROCESSING)
    expect(await shippedRows(order.id)).toHaveLength(0)
  })
})
