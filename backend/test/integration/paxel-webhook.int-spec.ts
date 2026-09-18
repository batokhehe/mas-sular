/**
 * Paxel webhook against REAL PostgreSQL, through the REAL NestJS HTTP route.
 *
 * The unit HTTP spec proves the behaviour against a Prisma double. This proves what a
 * double cannot: real transactions and rollback, the `SELECT ... FOR UPDATE` row lock
 * serializing CONCURRENT deliveries, the webhook racing the REAL poller on one row,
 * JSONB round-trips of the stored record, the real ShipmentHistory / OrderEvent /
 * NotificationOutbox rows, and the real customer order-list response.
 * No external call is made: Paxel is never contacted (the poller's courier is a stub),
 * media links are never fetched, and notifications stay PENDING outbox rows.
 */
import { randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { OrderStatus, ShipmentStatus } from '@prisma/client'
import { CsrfGuard } from '../../src/common/auth/csrf.guard'
import { PrismaService } from '../../src/database/prisma.service'
import { OrdersService } from '../../src/modules/orders/orders.service'
import { paxelWebhookSignature } from '../../src/modules/shipment/infrastructure/providers/paxel-signature'
import { PAXEL_WEBHOOK_CONFIG } from '../../src/modules/shipment/paxel-webhook.config'
import { PaxelWebhookService } from '../../src/modules/shipment/paxel-webhook.service'
import { PaxelWebhookController } from '../../src/modules/shipment/presentation/paxel-webhook.controller'
import { readPaxelWebhook, readShipmentMetadata } from '../../src/modules/shipment/shipment-metadata'
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory'
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper'
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

const SECRET = 'test-only-paxel-webhook-secret'

let world: IntegrationWorld
let app: INestApplication
let url: string

beforeAll(async () => {
  world = await getWorld()
  const moduleRef = await Test.createTestingModule({
    controllers: [PaxelWebhookController],
    providers: [
      { provide: PrismaService, useValue: world.prisma },
      { provide: ShipmentProviderFactory, useValue: { get: () => undefined, getAll: () => [] } },
      ShipmentStatusMapper,
      ShipmentSyncService,
      PaxelWebhookService,
      { provide: PAXEL_WEBHOOK_CONFIG, useValue: { enabled: true, secret: SECRET } },
    ],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  // The same global HTTP setup main.ts applies to this route.
  app.setGlobalPrefix('api')
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalGuards(new CsrfGuard())
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }))
  await app.listen(0, '127.0.0.1')
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/shipments/webhook/paxel`
}, 180_000)

afterAll(async () => {
  await app?.close()
})

async function post(body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Paxel-Signature': paxelWebhookSignature(String(body.airwaybill_code), String(body.latest_status), SECRET) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

/** A paid order handed to Paxel: shipment CREATED with an AWB, order SHIPPED. */
async function paxelShipment() {
  const scenario = await seedScenario(world, { paymentStatus: 'PAID', orderStatus: 'PROCESSING' })
  await world.prisma.order.update({ where: { id: scenario.order.id }, data: { status: OrderStatus.SHIPPED } })
  const awb = `MERCHANT-20260913-1-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
  const shipment = await world.prisma.shipment.create({
    data: {
      orderId: scenario.order.id, provider: 'paxel', service: 'PAXEL_SAMEDAY', status: ShipmentStatus.CREATED, cost: 18000,
      trackingNumber: awb, providerPayload: { data: { airwaybill_code: awb } }, metadata: { paxel: { pickupDatetime: '2026-09-13T10:00:00.000Z' } },
    },
  })
  return { scenario, shipment, awb, orderNumber: scenario.order.orderNumber }
}

const MEDIA = {
  photo: 'https://media.paxel.example/photo.jpg',
  signature: 'https://media.paxel.example/signature.png',
  pdo_photo: 'https://media.paxel.example/pdo/photo.jpg',
  pdo_signature: 'https://media.paxel.example/pdo/signature.png',
}

/** Shaped like the supplied Paxel example; `time` is its logs.created_datetime. */
const push = (awb: string, orderNumber: string, status: string, time: string, over: Record<string, unknown> = {}) => ({
  actual_price: 50000, actual_weight: 1000, airwaybill_code: awb, cancellation_reason: '', delivery_datetime: '2026-09-13 14:00:00',
  driver_name: 'Heri', invoice_number: orderNumber, latest_status: status,
  logs: {
    address: 'Muara karang Blok 7', city: 'KOTA JAKARTA UTARA', created_datetime: time, district: 'Penjaringan',
    latitude: -6.1799, longitude: 106.581593, name: '-', note: `status ${status}`, province: 'DKI JAKARTA', status,
  },
  money: { bill_note: 'Uang yang diterima asli', collect_money: 10000.123 },
  receiver_name: 'Richardo Moren Silaholo', sender_name: 'Jhon Doe',
  items: [{ code: 'SKU0000000001', name: 'Samsung J9', category: 'Handphone', special_insurance: false }],
  ...over,
})

const pdo = (awb: string, orderNumber: string) => push(awb, orderNumber, 'PDO', '2026-09-13 15:00:00', MEDIA)

async function state(shipmentId: string, orderId: string) {
  const shipment = await world.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
  return {
    shipment,
    record: readPaxelWebhook(shipment.metadata),
    order: await world.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await world.prisma.shipmentHistory.findMany({ where: { shipmentId }, orderBy: { createdAt: 'asc' } }),
    orderEvents: await world.prisma.orderEvent.findMany({ where: { orderId, note: { startsWith: 'Shipment' } }, orderBy: { createdAt: 'asc' } }),
    outbox: await world.prisma.notificationOutbox.findMany({ where: { template: 'shipment.status', payload: { path: ['orderId'], equals: orderId } }, orderBy: { createdAt: 'asc' } }),
  }
}

const statuses = (outbox: { payload: unknown }[]) => outbox.map((o) => (o.payload as { shipmentStatus: string }).shipmentStatus)

/** The REAL poller with a stub Paxel courier answering only for the AWBs under test. */
function pollerAnswering(answers: Map<string, string>) {
  const courier = {
    name: 'paxel',
    trackShipmentRaw: async (tracking: string) => {
      const status = answers.get(tracking)
      // The shared test database holds other specs' shipments: never answer for them
      // (the poller isolates per-shipment errors, so they are simply skipped).
      if (!status) throw new Error('not a shipment under test')
      return { providerStatus: status, rawPayload: { data: { airwaybill_code: tracking, latest_status: status } } }
    },
  }
  return new ShipmentSyncService(world.prisma, { get: () => courier, getAll: () => [courier] } as never, new ShipmentStatusMapper())
}

describe('Paxel webhook: PDO on real PostgreSQL', () => {
  it('PDO → shipment DELIVERED, order DELIVERED, one ShipmentHistory row, one PENDING notification, internals persisted', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    const fetchSpy = jest.spyOn(global, 'fetch')
    const before = new Date()
    expect(await post(pdo(awb, orderNumber))).toEqual({ status: 200, body: { received: true } })
    const after = new Date()
    // Media are stored as links only: the ONLY outbound request was our own POST.
    expect(fetchSpy.mock.calls.map(([u]) => String(u))).toEqual([url])
    fetchSpy.mockRestore()

    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(s.shipment.cost).toBe(18000) // actual_price never replaces the charged shipping
    expect(s.order.status).toBe(OrderStatus.DELIVERED)
    expect(s.history.map((h) => [h.providerStatus, h.mappedStatus])).toEqual([['PDO', ShipmentStatus.DELIVERED]])
    expect(s.history[0].changedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(s.history[0].changedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(s.orderEvents.map((e) => e.status)).toEqual([OrderStatus.DELIVERED])
    expect(statuses(s.outbox)).toEqual(['DELIVERED'])
    expect(s.outbox.every((o) => o.status === 'PENDING')).toBe(true) // queued only - nothing sent

    // Courier-internal record in metadata.paxel.webhook (JSONB round-trip).
    expect(s.record).toMatchObject({
      version: 1,
      airwaybillCode: awb,
      lastAppliedStatus: 'PDO',
      lastAppliedEventAt: '2026-09-13 15:00:00', // verbatim Paxel log time
      latest: {
        latestStatus: 'PDO', invoiceNumber: orderNumber, driverName: 'Heri', receiverName: 'Richardo Moren Silaholo', senderName: 'Jhon Doe',
        deliveryDatetime: '2026-09-13 14:00:00',
        actualPrice: { raw: '50000', value: 50000 }, actualWeight: { raw: '1000', value: 1000 },
        media: { photoUrl: MEDIA.photo, signatureUrl: MEDIA.signature, pdoPhotoUrl: MEDIA.pdo_photo, pdoSignatureUrl: MEDIA.pdo_signature },
        money: { collectMoney: { raw: '10000.123', value: 10000.123 }, billNote: 'Uang yang diterima asli' },
        items: [{ code: 'SKU0000000001', name: 'Samsung J9', category: 'Handphone', specialInsurance: false }],
      },
    })
    expect(s.record!.logs).toEqual([expect.objectContaining({ status: 'PDO', createdDatetime: '2026-09-13 15:00:00', latitude: -6.1799 })])
    expect((s.shipment.metadata as { paxel: { pickupDatetime: string } }).paxel.pickupDatetime).toBe('2026-09-13T10:00:00.000Z')
    // providerPayload: identifiers only.
    expect(s.shipment.providerPayload).toMatchObject({ source: 'paxel.webhook', airwaybillCode: awb, latestStatus: 'PDO' })
    expect(JSON.stringify(s.shipment.providerPayload)).not.toMatch(/Richardo|Heri|media\.paxel|Uang/)
  })
})

describe('Paxel webhook: idempotency, staleness and terminal states on real PostgreSQL', () => {
  it('10 CONCURRENT + 10 sequential identical PDO pushes → one transition, one history row, one notification', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    const body = pdo(awb, orderNumber)
    const results = await Promise.all(Array.from({ length: 10 }, () => post(body)))
    for (let i = 0; i < 10; i++) results.push(await post(body))
    expect(results.every((r) => r.status === 200 && r.body.received === true)).toBe(true)

    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([1, 1, 1])
    expect(s.record!.observations).toHaveLength(1)
    expect(s.record!.logs).toHaveLength(1)
  })

  it('a stale status after PDO (POL, then POD) changes nothing and notifies nobody; the observations are kept', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    await post(pdo(awb, orderNumber))
    expect((await post(push(awb, orderNumber, 'POL', '2026-09-13 10:00:00'))).body).toEqual({ received: true })
    expect((await post(push(awb, orderNumber, 'POD', '2026-09-13 12:00:00'))).body).toEqual({ received: true })
    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(s.order.status).toBe(OrderStatus.DELIVERED)
    expect(statuses(s.outbox)).toEqual(['DELIVERED'])
    expect(s.record!.latest.latestStatus).toBe('PDO') // older pushes never overwrite the latest figures
    expect(s.record!.observations.map((o) => o.latestStatus)).toEqual(['PDO', 'POL', 'POD'])
    expect(s.record!.logs.map((l) => l.status)).toEqual(['POL', 'POD', 'PDO']) // chronological
  })

  it('CCS → shipment CANCELLED, order CANCELLED; terminal: a later PDO changes nothing', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    expect((await post(push(awb, orderNumber, 'CCS', '2026-09-13 11:00:00', { cancellation_reason: 'dibatalkan oleh penjual' }))).body).toEqual({ received: true })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CANCELLED)
    expect(s.order.status).toBe(OrderStatus.CANCELLED)
    expect(statuses(s.outbox)).toEqual(['CANCELLED'])
    expect(s.record!.latest.cancellationReason).toBe('dibatalkan oleh penjual')

    expect((await post(pdo(awb, orderNumber))).body).toEqual({ received: true })
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CANCELLED)
    expect(s.order.status).toBe(OrderStatus.CANCELLED)
    expect(s.history).toHaveLength(1)
    expect(statuses(s.outbox)).toEqual(['CANCELLED'])
  })

  it.each(['FAILED3PL', 'ONHOLD3PL'])('an unconfirmed status (%s) stays AS-IS: recorded without any transition; the lifecycle then continues', async (code) => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    expect((await post(push(awb, orderNumber, code, '2026-09-13 13:00:00'))).body).toEqual({ received: true })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect([s.history.length, s.outbox.length]).toEqual([0, 0])
    expect(s.record!.observations).toEqual([expect.objectContaining({ latestStatus: code, mappedStatus: null })])

    await post(pdo(awb, orderNumber))
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
  })

  it('the documented Paxel lifecycle (RTP, COL, PAPV, POLXL, HAPH, ODLXL, COD, ODL, PDO) moves forward once per internal state; replaying it changes nothing', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    const sequence: Array<[string, string, ShipmentStatus]> = [
      ['RTP', '2026-09-13 08:00:00', ShipmentStatus.CREATED], // Shipment successfully created (already CREATED)
      ['COL', '2026-09-13 08:30:00', ShipmentStatus.WAITING_PICKUP], // Courier has arrived at pickup location
      ['PAPV', '2026-09-13 09:00:00', ShipmentStatus.PICKED_UP], // Courier has picked up your shipment
      ['POLXL', '2026-09-13 10:00:00', ShipmentStatus.IN_TRANSIT], // Package on Origin Locker
      ['HAPH', '2026-09-13 11:00:00', ShipmentStatus.IN_TRANSIT], // Hold at Paxel Home
      ['ODLXL', '2026-09-13 12:00:00', ShipmentStatus.IN_TRANSIT], // Package on Destination Locker
      ['COD', '2026-09-13 13:00:00', ShipmentStatus.OUT_FOR_DELIVERY], // Courier has arrived at destination
      ['ODL', '2026-09-13 14:00:00', ShipmentStatus.OUT_FOR_DELIVERY], // On Delivery
      ['PDO', '2026-09-13 15:00:00', ShipmentStatus.DELIVERED], // Delivery is Completed
    ]
    for (const [code, time, expected] of sequence) {
      expect((await post(push(awb, orderNumber, code, time))).body).toEqual({ received: true })
      expect([code, (await state(shipment.id, scenario.order.id)).shipment.status]).toEqual([code, expected])
    }
    let s = await state(shipment.id, scenario.order.id)
    expect(s.history.map((h) => h.mappedStatus)).toEqual(['WAITING_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
    expect(statuses(s.outbox)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'])
    expect(s.order.status).toBe('DELIVERED')

    // Paxel retries: the whole sequence again adds nothing.
    for (const [code, time] of sequence) expect((await post(push(awb, orderNumber, code, time))).body).toEqual({ received: true })
    s = await state(shipment.id, scenario.order.id)
    expect(s.history).toHaveLength(5)
    expect(s.outbox).toHaveLength(4)
  })

  it('PRJL ("Pickup cancelled by courier") fails the shipment but never cancels the order', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    expect((await post(push(awb, orderNumber, 'PRJL', '2026-09-13 09:00:00'))).body).toEqual({ received: true })
    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.FAILED)
    expect(s.order.status).not.toBe('CANCELLED')
    expect(statuses(s.outbox)).toEqual(['FAILED'])
  })

  it('unknown AWB → 404 and invoice_number mismatch → 409: nothing is created or modified', async () => {
    const { shipment, scenario, awb } = await paxelShipment()
    const before = await world.prisma.shipment.count()
    expect((await post(push('MERCHANT-DOES-NOT-EXIST', 'BMS-X', 'PDO', '2026-09-13 15:00:00'))).status).toBe(404)
    expect((await post(push(awb, 'BMS-SOMEONE-ELSE', 'PDO', '2026-09-13 15:00:00'))).status).toBe(409)
    expect(await world.prisma.shipment.count()).toBe(before)
    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect(s.record).toBeUndefined()
    expect([s.history.length, s.outbox.length]).toEqual([0, 0])
  })

  it('a failure inside the transition rolls back EVERYTHING (500); the retry applies exactly once', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    // Fails while building the notification - after the status CAS, history row and
    // order advance were already written inside the same transaction.
    const label = jest.spyOn(ShipmentStatusMapper.prototype, 'label').mockImplementationOnce(() => {
      throw new Error('simulated failure mid-transition')
    })
    expect(await post(pdo(awb, orderNumber))).toEqual({ status: 500, body: { received: false, reason: 'internal error' } })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect(s.order.status).toBe(OrderStatus.SHIPPED)
    expect(s.record).toBeUndefined()
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([0, 0, 0])
    label.mockRestore()

    expect(await post(pdo(awb, orderNumber))).toEqual({ status: 200, body: { received: true } })
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([1, 1, 1])
  })
})

describe('Paxel webhook vs the REAL poller on the same rows (real PostgreSQL)', () => {
  it('webhook PDO and poller PDO racing on 5 shipments → each ends DELIVERED with exactly one history row and one notification', async () => {
    const shipments = await Promise.all(Array.from({ length: 5 }, () => paxelShipment()))
    const poller = pollerAnswering(new Map(shipments.map((x) => [x.awb, 'PDO'])))
    await Promise.all([
      poller.syncAll(1000),
      ...shipments.map((x) => post(pdo(x.awb, x.orderNumber))),
      poller.syncAll(1000),
    ])
    for (const x of shipments) {
      const s = await state(x.shipment.id, x.scenario.order.id)
      expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
      expect(s.order.status).toBe(OrderStatus.DELIVERED)
      expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([1, 1, 1])
      // Whichever path won, the webhook's observation is recorded either way.
      expect(s.record!.observations.map((o) => o.latestStatus)).toEqual(['PDO'])
    }
  })

  it('webhook POL and poller PDO racing → never regressed, one notification per transition, DELIVERED by the next tick', async () => {
    const x = await paxelShipment()
    const poller = pollerAnswering(new Map([[x.awb, 'PDO']]))
    await Promise.all([post(push(x.awb, x.orderNumber, 'POL', '2026-09-13 10:00:00')), poller.syncAll(1000)])
    let s = await state(x.shipment.id, x.scenario.order.id)
    // Either order is correct: poller first → DELIVERED (the late POL is refused as
    // terminal); webhook first → IN_TRANSIT and the poller's CAS on the CREATED it had
    // read is LOST (no write at all), so it lands on its next tick.
    expect([ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED]).toContain(s.shipment.status)
    await poller.syncAll(1000)
    s = await state(x.shipment.id, x.scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(new Set(statuses(s.outbox)).size).toBe(s.outbox.length) // no status notified twice
    expect(s.history.length).toBe(s.outbox.length)
    expect(statuses(s.outbox)[statuses(s.outbox).length - 1]).toBe('DELIVERED')
  })

  it('a stale poll after the webhook delivered (poller still says POL) is refused and recorded; the webhook record is untouched', async () => {
    const x = await paxelShipment()
    await post(pdo(x.awb, x.orderNumber))
    const webhookBefore = (await state(x.shipment.id, x.scenario.order.id)).record

    // The poller only picks non-terminal shipments, so a DELIVERED one is not even
    // polled: prove it, then prove the shared rule directly for an in-flight shipment.
    const poller = pollerAnswering(new Map([[x.awb, 'POL']]))
    await poller.syncAll(1000)
    let s = await state(x.shipment.id, x.scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(s.record).toEqual(webhookBefore)

    const y = await paxelShipment()
    await post(push(y.awb, y.orderNumber, 'POD', '2026-09-13 12:00:00'))
    await pollerAnswering(new Map([[y.awb, 'POL']])).syncAll(1000)
    await pollerAnswering(new Map([[y.awb, 'POL']])).syncAll(1000) // same stale answer again: recorded once
    s = await state(y.shipment.id, y.scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.OUT_FOR_DELIVERY)
    expect(statuses(s.outbox)).toEqual(['OUT_FOR_DELIVERY'])
    expect(readShipmentMetadata(s.shipment.metadata).tracking?.rejected).toEqual([
      expect.objectContaining({ provider: 'paxel', providerStatus: 'POL', shipmentStatus: 'OUT_FOR_DELIVERY', reason: 'would_regress' }),
    ])
    expect(s.record!.latest.latestStatus).toBe('POD')
  })
})

describe('Paxel webhook data vs customers and admins (real PostgreSQL)', () => {
  it('the customer order-list response does NOT expose the courier-internal webhook data', async () => {
    const { scenario, awb, orderNumber } = await paxelShipment()
    await post(pdo(awb, orderNumber))
    // The real customer-facing service method behind GET /api/v1/orders/users/:userId.
    const orders = new OrdersService(world.prisma, {} as never, {} as never, {} as never)
    const list = (await orders.listForUser(scenario.userId)) as Array<{ id: string; shipment: { status: string; metadata: Record<string, any> | null } | null }>
    const mine = list.find((o) => o.id === scenario.order.id)!
    expect(mine.shipment!.status).toBe(ShipmentStatus.DELIVERED) // the customer still sees the status
    expect(mine.shipment!.metadata).toEqual({ paxel: { pickupDatetime: '2026-09-13T10:00:00.000Z' } })
    const serialized = JSON.stringify(mine)
    for (const internal of ['Richardo', 'Heri', 'Jhon Doe', 'media.paxel.example', 'Uang yang diterima', 'Muara karang', 'collectMoney', 'actualPrice']) {
      expect(serialized).not.toContain(internal)
    }
  })

  it('an unrelated admin metadata edit keeps paxel.webhook and every other namespace', async () => {
    const { shipment, scenario, awb, orderNumber } = await paxelShipment()
    await post(pdo(awb, orderNumber))
    const before = await state(shipment.id, scenario.order.id)
    await world.admin.updateShipment(shipment.id, { metadata: { opsNote: 'call receiver before 17:00', paxel: { webhook: { forged: true } } } } as never)
    const after = await state(shipment.id, scenario.order.id)
    expect(after.record).toEqual(before.record)
    const metadata = after.shipment.metadata as { paxel: { pickupDatetime: string }; opsNote: string }
    expect(metadata.paxel.pickupDatetime).toBe('2026-09-13T10:00:00.000Z')
    expect(metadata.opsNote).toBe('call receiver before 17:00')
  })
})
