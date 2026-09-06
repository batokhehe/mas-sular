/**
 * PAXELBOX-61AG.3.29 — WhatsApp lifecycle end to end, against real MySQL.
 *
 * Everything downstream of the domain transaction is the real thing: the real
 * OrderCreatedNotificationConsumer, the real ShipmentService transitions, the
 * real NotificationOutbox rows, the real NotificationMessageBuilder (which loads
 * the active PaymentAccount from the database), the real TemplateRegistry and
 * the real QontakWhatsAppProvider. Only two edges are substituted:
 *
 *   • the Qontak HTTP transport — stubbed, so payloads are captured, never sent
 *   • the courier provider factory — stubbed, so no Paxel/JNE call is made
 *
 * Disposable MySQL from ./world. No shared dev, no production, no real API.
 */
import { NotificationChannel, NotificationOutbox, PaymentMethod, ShipmentStatus } from '@prisma/client'
import { randomUUID } from 'crypto'
import { OrderCreatedNotificationConsumer } from '../../src/infrastructure/consumers/order-created-notification.consumer'
import { loadConsumersConfig } from '../../src/infrastructure/consumers/consumers.config'
import { ShipmentService } from '../../src/modules/shipment/shipment.service'
import { TemplateRegistry } from '../../src/infrastructure/notifications/template-registry'
import { NotificationMessageBuilder } from '../../src/infrastructure/notifications/notification-message.builder'
import { QontakWhatsAppProvider } from '../../src/infrastructure/notifications/qontak-whatsapp.provider'
import {
  NotificationDeliveryGate,
  NotificationBlockedError,
  loadNotificationDeliveryConfig,
} from '../../src/infrastructure/notifications/notification-delivery.gate'
import { getWorld, IntegrationWorld } from './world'

const ADMIN_PHONE = '628990000111'
const CUSTOMER_PHONE = '628123456789'
const TPL = {
  QONTAK_INVOICE_TEMPLATE_ID: 'INVOICE-TPL',
  QONTAK_ORDER_TEMPLATE_ID: 'ORDER-TPL',
  QONTAK_SHIPPED_TEMPLATE_ID: 'SHIPPED-TPL',
  QONTAK_DELIVERED_TEMPLATE_ID: 'DELIVERED-TPL',
  QONTAK_COD_TEMPLATE_ID: 'COD-TPL',
}

interface QontakBody {
  to_name: string
  to_number: string
  message_template_id: string
  parameters: { body: { key: string; value: string; value_text: string }[]; buttons?: { value: string }[] }
}

describe('WA lifecycle (real DB, stubbed Qontak)', () => {
  let world: IntegrationWorld
  let registry: TemplateRegistry

  beforeAll(async () => {
    world = await getWorld()
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(TPL)) { saved[k] = process.env[k]; process.env[k] = v }
    registry = new TemplateRegistry()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  // -------------------------------------------------------------- fixtures --

  async function seedOrder(opts: { method?: PaymentMethod; provider?: string; service?: string } = {}) {
    const { prisma } = world
    const uid = randomUUID().slice(0, 8)
    const cat = await prisma.category.create({ data: { name: `wa-${uid}`, slug: `wa-${uid}` } })
    const product = await prisma.product.create({
      data: { slug: `wa-${uid}`, sku: `WA-${uid}`, name: 'Bakso', description: 'x', price: 30000, imageUrl: '/x.png', stock: 10, categoryId: cat.id },
    })
    const user = await prisma.user.create({ data: { email: `wa-${uid}@test.local`, name: 'Budi' } })
    const address = await prisma.address.create({
      data: { userId: user.id, label: 'H', recipientName: 'Budi', phone: CUSTOMER_PHONE, fullAddress: 'Jl Test', postalCode: '40111', latitude: 0, longitude: 0 },
    })
    const order = await prisma.order.create({
      data: {
        orderNumber: `WA-${uid}`, userId: user.id, addressId: address.id,
        subtotal: 30000, deliveryFee: 10000, totalPrice: 154378,
        paymentMethod: opts.method ?? PaymentMethod.BANK_TRANSFER,
        shippingProvider: opts.provider ?? null,
        shippingService: opts.service ?? null,
        shippingServiceName: opts.service ? `${opts.service} Display Label` : null,
        items: { create: { productId: product.id, productName: product.name, unitPrice: 30000, quantity: 1 } },
        payment: { create: { method: opts.method ?? PaymentMethod.BANK_TRANSFER, amount: 154378, status: 'PENDING' } },
      },
      include: { payment: true },
    })
    return { order, uid }
  }

  /** createForOrder refuses to book without an active origin outlet. */
  async function ensureOutlet() {
    const existing = await world.prisma.outlet.findFirst({ where: { isActive: true, postalCode: { not: null } } })
    if (existing) return existing
    return world.prisma.outlet.create({
      data: { name: 'Origin', isActive: true, postalCode: '40286', latitude: -6.9, longitude: 107.6, addressDetail: 'Jl Origin' },
    })
  }

  /** An active bank account must exist — the invoice builder reads it from the DB. */
  async function ensurePaymentAccount() {
    const existing = await world.prisma.paymentAccount.findFirst({ where: { isActive: true } })
    if (existing) return existing
    return world.prisma.paymentAccount.create({
      data: { bankName: 'BCA', bankCode: '014', accountName: 'Bakso Mas Sular', accountNumber: '1234567890', isActive: true },
    })
  }

  function consumerFor() {
    return new OrderCreatedNotificationConsumer(
      world.prisma as never, {} as never,
      { enqueued: () => {}, duplicate: () => {}, skipped: () => {}, consumerRetried: () => {} } as never,
      { ...loadConsumersConfig({}), opsNotificationWhatsapp: ADMIN_PHONE } as never,
    )
  }

  /** Build the persisted row and send it through the real provider; capture the body. */
  async function sendRow(row: NotificationOutbox): Promise<QontakBody> {
    const builder = new NotificationMessageBuilder(
      { getActiveAccount: async () => {
        const a = await ensurePaymentAccount()
        return { id: a.id, bankName: a.bankName, bankCode: a.bankCode, accountName: a.accountName, accountNumber: a.accountNumber }
      } } as never,
      registry,
    )
    const message = await builder.build(row)
    let captured: QontakBody | undefined
    const provider = new QontakWhatsAppProvider(
      { baseUrl: 'https://qontak.invalid', apiToken: 't', channelIntegrationId: 'c', timeoutMs: 1000, maxRetry: 0 } as never,
      registry as never,
    )
    ;(provider as unknown as { http: unknown }).http = async (_u: string, init: { body?: string }) => {
      captured = JSON.parse(String(init.body)) as QontakBody
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { id: 'q' } }) }
    }
    await provider.send(message)
    return captured!
  }

  const rowsFor = (orderId: string, template?: string) =>
    world.prisma.notificationOutbox.findMany({
      where: { template, payload: { path: '$.orderId', equals: orderId } },
      orderBy: { createdAt: 'asc' },
    })

  /** ShipmentService wired to a courier stub — no real Paxel/JNE call. */
  function shipmentServiceWith(name: string, tracking: string) {
    let calls = 0
    const provider = {
      name,
      createShipment: async () => { calls += 1; return { status: ShipmentStatus.IN_TRANSIT, trackingNumber: tracking, providerShipmentId: `${name}-1`, rawPayload: {} } },
      trackShipment: async () => ({ status: ShipmentStatus.DELIVERED, rawPayload: {} }),
    }
    const svc = new ShipmentService(world.prisma as never, { get: () => provider } as never)
    return { svc, provider, calls: () => calls }
  }

  // ============================================================ A. CREATED ==

  describe('A. TRANSFER order created', () => {
    it('produces the customer invoice exactly per contract', async () => {
      const { order } = await seedOrder()
      await ensurePaymentAccount()
      const token = 'b'.repeat(64)
      const msgId = randomUUID() // 36 chars, exactly as the relay emits

      await consumerFor().process(msgId, {
        name: 'order.created',
        payload: { orderId: order.id, orderNumber: order.orderNumber, totalPrice: 154378, uploadUrl: `http://x/payments/upload/${token}` },
      })

      const [row] = await rowsFor(order.id, 'order.transfer')
      expect(row).toBeDefined()
      expect(row.recipient).toBe(CUSTOMER_PHONE)

      const body = await sendRow(row)
      expect(body.message_template_id).toBe(TPL.QONTAK_INVOICE_TEMPLATE_ID)
      expect(body.to_number).toBe(CUSTOMER_PHONE)
      const p = body.parameters.body
      expect(p).toHaveLength(6)
      expect(p.map((x) => x.value)).toEqual(['customer_name', 'order_no', 'price', 'bank_name', 'account_name', 'account_number'])
      expect(p[0].value_text).toBe('Budi')
      expect(p[1].value_text).toBe(order.orderNumber)
      expect(p[2].value_text).toBe('Rp 154.378')
      expect(p[3].value_text).toBe('BCA')             // from the DB PaymentAccount
      expect(p[4].value_text).toBe('Bakso Mas Sular')
      expect(p[5].value_text).toBe('1234567890')
      // CTA carries the RAW upload token, never the order id, never a full URL.
      expect(body.parameters.buttons).toEqual([{ index: '0', type: 'url', value: token }])
      expect(body.parameters.buttons![0].value).not.toBe(order.id)
    })

    it('produces the admin alert exactly per contract, addressed to QONTAK_ADMIN', async () => {
      const { order } = await seedOrder()
      const msgId = randomUUID() // 36 chars, exactly as the relay emits

      await consumerFor().process(msgId, {
        name: 'order.created',
        payload: { orderId: order.id, uploadUrl: `http://x/payments/upload/${'c'.repeat(64)}` },
      })

      const [row] = await rowsFor(order.id, 'order.new')
      expect(row.recipient).toBe(ADMIN_PHONE)
      expect(row.recipient).not.toBe(CUSTOMER_PHONE)

      const body = await sendRow(row)
      expect(body.message_template_id).toBe(TPL.QONTAK_ORDER_TEMPLATE_ID)
      expect(body.to_number).toBe(ADMIN_PHONE)
      const p = body.parameters.body
      expect(p).toHaveLength(6)
      expect(p.map((x) => x.value)).toEqual(['order_no', 'customer_name', 'total', 'payment_method', 'payment_status', 'shipping_method'])
      expect(p[0].value_text).toBe(order.orderNumber)
      expect(p[1].value_text).toBe('Budi')
      expect(p[2].value_text).toBe('Rp 154.378')
      expect(p[3].value_text).toBe('BANK_TRANSFER')
      expect(p[4].value_text).toBe('PENDING')
      // CTA identifier must be Order.id — the admin route resolves it by id.
      expect(body.parameters.buttons).toEqual([{ index: '0', type: 'url', value: order.id }])
      expect(body.parameters.buttons![0].value).not.toBe(order.orderNumber)
    })
  })

  // ====================================================== B/C. SHIPPED =====

  describe.each([
    ['paxel', 'PAXEL', 'PXL123456789'],
    ['jne', 'JNE', 'JNE0001234567'],
  ])('%s shipped', (providerId, expectedCourier, awb) => {
    it(`sends courier "${expectedCourier}" alone, with the AWB and no service`, async () => {
      const { order } = await seedOrder({ provider: providerId, service: `${providerId.toUpperCase()}_EXPRESS` })
      await world.prisma.shipment.create({
        data: { orderId: order.id, provider: providerId, service: `${providerId.toUpperCase()}_EXPRESS`, status: ShipmentStatus.RATE_SELECTED, cost: 10000 },
      })
      await ensureOutlet()
      const { svc } = shipmentServiceWith(providerId, awb)

      await svc.createForOrder(order.id)

      const [row] = await rowsFor(order.id, 'order.shipped')
      expect(row).toBeDefined()
      expect(row.recipient).toBe(CUSTOMER_PHONE)

      const body = await sendRow(row)
      expect(body.message_template_id).toBe(TPL.QONTAK_SHIPPED_TEMPLATE_ID)
      const p = body.parameters.body
      expect(p).toHaveLength(4)
      expect(p.map((x) => x.value)).toEqual(['customer_name', 'order_no', 'courier', 'tracking'])
      expect(p[0].value_text).toBe('Budi')
      expect(p[1].value_text).toBe(order.orderNumber)
      expect(p[2].value_text).toBe(expectedCourier)   // exactly PAXEL / JNE
      expect(p[3].value_text).toBe(awb)
      // The service code and its display label must NOT appear anywhere.
      const rendered = JSON.stringify(body)
      expect(rendered).not.toContain('_EXPRESS')
      expect(rendered).not.toContain('Display Label')
      expect(body.parameters.buttons).toBeUndefined()
    })
  })

  // ========================================================== D. DELIVERED =

  describe('D. delivered', () => {
    it('sends exactly two parameters and no courier/tracking', async () => {
      const { order } = await seedOrder({ provider: 'jne', service: 'REG' })
      await world.prisma.shipment.create({
        data: { orderId: order.id, provider: 'jne', service: 'REG', status: ShipmentStatus.IN_TRANSIT, cost: 1, trackingNumber: 'JNE9999' },
      })
      await world.prisma.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } })
      const { svc } = shipmentServiceWith('jne', 'JNE9999')

      await svc.pollAndUpdate()

      const [row] = await rowsFor(order.id, 'order.delivered')
      expect(row).toBeDefined()

      const body = await sendRow(row)
      expect(body.message_template_id).toBe(TPL.QONTAK_DELIVERED_TEMPLATE_ID)
      const p = body.parameters.body
      expect(p).toHaveLength(2)
      expect(p.map((x) => x.value)).toEqual(['customer_name', 'order_no'])
      expect(p.map((x) => x.value_text)).toEqual(['Budi', order.orderNumber])
      expect(JSON.stringify(body)).not.toContain('JNE9999')
    })
  })

  // ================================================ E. DUPLICATE PROTECTION =

  describe('E. duplicate protection', () => {
    it('a replayed order.created enqueues nothing further', async () => {
      const { order } = await seedOrder()
      const msgId = randomUUID()
      const payload = { orderId: order.id, uploadUrl: `http://x/payments/upload/${'d'.repeat(64)}` }

      const first = await consumerFor().process(msgId, { name: 'order.created', payload })
      const second = await consumerFor().process(msgId, { name: 'order.created', payload })

      expect(first).toBe('enqueued')
      expect(second).toBe('duplicate')
      expect(await rowsFor(order.id, 'order.transfer')).toHaveLength(1)
      expect(await rowsFor(order.id, 'order.new')).toHaveLength(1)
    })

    it('a repeated shipped transition does not enqueue twice', async () => {
      const { order } = await seedOrder({ provider: 'paxel', service: 'INSTANT' })
      await world.prisma.shipment.create({
        data: { orderId: order.id, provider: 'paxel', service: 'INSTANT', status: ShipmentStatus.RATE_SELECTED, cost: 1 },
      })
      await ensureOutlet()
      const { svc } = shipmentServiceWith('paxel', 'PXL-DUP')

      await svc.createForOrder(order.id)
      await svc.createForOrderSafe(order.id) // second attempt; order is already SHIPPED

      expect(await rowsFor(order.id, 'order.shipped')).toHaveLength(1)
    })

    it('a repeated delivered sync does not enqueue twice', async () => {
      const { order } = await seedOrder({ provider: 'jne', service: 'REG' })
      await world.prisma.shipment.create({
        data: { orderId: order.id, provider: 'jne', service: 'REG', status: ShipmentStatus.IN_TRANSIT, cost: 1, trackingNumber: 'JNE-DUP' },
      })
      await world.prisma.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } })
      const { svc } = shipmentServiceWith('jne', 'JNE-DUP')

      await svc.pollAndUpdate()
      await svc.pollAndUpdate()

      expect(await rowsFor(order.id, 'order.delivered')).toHaveLength(1)
    })
  })

  // ==================================================== F. ROLLBACK ========

  describe('F. rollback', () => {
    it('a failure inside the enqueue transaction leaves no notification and no processed-event', async () => {
      const { order } = await seedOrder()
      const msgId = randomUUID()
      const consumer = consumerFor()

      // Fail AFTER the outbox rows are written, still inside the same transaction.
      const realTx = world.prisma.$transaction.bind(world.prisma)
      const spy = jest
        .spyOn(world.prisma, '$transaction')
        .mockImplementation(((cb: (tx: unknown) => Promise<unknown>) =>
          realTx(async (tx: unknown) => {
            await cb(tx)
            throw new Error('boom after enqueue')
          })) as never)

      await expect(
        consumer.process(msgId, { name: 'order.created', payload: { orderId: order.id, uploadUrl: `http://x/payments/upload/${'e'.repeat(64)}` } }),
      ).rejects.toThrow('boom after enqueue')
      spy.mockRestore()

      // Nothing survived: no orphan notification claiming an order that never committed.
      expect(await rowsFor(order.id)).toHaveLength(0)
      expect(
        await world.prisma.processedEvent.findFirst({ where: { messageId: msgId } }),
      ).toBeNull()

      // And the event is still processable afterwards — the rollback did not
      // consume the idempotency slot.
      const outcome = await consumerFor().process(msgId, {
        name: 'order.created',
        payload: { orderId: order.id, uploadUrl: `http://x/payments/upload/${'f'.repeat(64)}` },
      })
      expect(outcome).toBe('enqueued')
      expect(await rowsFor(order.id, 'order.transfer')).toHaveLength(1)
    })
  })

  // ================================================== G. DELIVERY GATE =====

  describe('G. delivery gate', () => {
    const message = (phone: string) => ({ channel: NotificationChannel.WHATSAPP, recipient: { name: 'x', phone } })

    it('admits an allowlisted recipient and blocks everything else', () => {
      const gate = new NotificationDeliveryGate(
        loadNotificationDeliveryConfig({
          NOTIFICATION_DELIVERY_ENABLED: 'true',
          NOTIFICATION_ALLOWED_RECIPIENTS: `0${CUSTOMER_PHONE.slice(2)}`,
        }),
      )
      expect(() => gate.assertDeliverable(message(CUSTOMER_PHONE) as never)).not.toThrow()
      expect(() => gate.assertDeliverable(message(ADMIN_PHONE) as never)).toThrow(NotificationBlockedError)
    })

    it('still fails closed with the switch on but an empty allowlist', () => {
      const gate = new NotificationDeliveryGate(
        loadNotificationDeliveryConfig({ NOTIFICATION_DELIVERY_ENABLED: 'true' }),
      )
      expect(() => gate.assertDeliverable(message(CUSTOMER_PHONE) as never)).toThrow(
        /NOTIFICATION_ALLOWED_RECIPIENTS is empty/,
      )
    })
  })

  // ================================================ H. GATEWAY REGRESSION ==

  describe('H. GATEWAY regression', () => {
    it('creates the admin alert only, with no transfer row and no crash', async () => {
      const { order } = await seedOrder({ method: PaymentMethod.GATEWAY })

      const outcome = await consumerFor().process(randomUUID(), {
        name: 'order.created',
        payload: { orderId: order.id }, // no uploadUrl: checkout issues none for GATEWAY
      })

      expect(outcome).toBe('enqueued')
      expect(await rowsFor(order.id, 'order.transfer')).toHaveLength(0)
      const admin = await rowsFor(order.id, 'order.new')
      expect(admin).toHaveLength(1)
      // The admin alert still builds and sends without an upload token.
      const body = await sendRow(admin[0])
      expect(body.parameters.body[3].value_text).toBe('GATEWAY')
    })
  })
})
