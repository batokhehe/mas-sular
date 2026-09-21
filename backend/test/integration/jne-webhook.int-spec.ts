/**
 * JNE Webhook Status V2 against REAL PostgreSQL, through the REAL NestJS HTTP route.
 *
 * The unit HTTP spec proves the behaviour against a Prisma double. This proves what
 * a double cannot: real transactions and rollback, the `SELECT ... FOR UPDATE` row
 * lock serializing CONCURRENT duplicate deliveries, JSONB round-trips of the stored
 * record, and the real ShipmentHistory / OrderEvent / NotificationOutbox rows.
 * No external call is made: JNE is never contacted, and notifications stay PENDING
 * outbox rows (no sender runs here).
 */
import { randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { OrderStatus, ShipmentStatus } from '@prisma/client'
import { CsrfGuard } from '../../src/common/auth/csrf.guard'
import { PrismaService } from '../../src/database/prisma.service'
import { JNE_WEBHOOK_CONFIG } from '../../src/modules/shipment/jne-webhook.config'
import { JneWebhookService } from '../../src/modules/shipment/jne-webhook.service'
import { JneWebhookController } from '../../src/modules/shipment/presentation/jne-webhook.controller'
import { readJneWebhook, readShipmentMetadata } from '../../src/modules/shipment/shipment-metadata'
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory'
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper'
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service'
import { getWorld, seedScenario, type IntegrationWorld } from './world'

let world: IntegrationWorld
let app: INestApplication
let url: string

beforeAll(async () => {
  world = await getWorld()
  const moduleRef = await Test.createTestingModule({
    controllers: [JneWebhookController],
    providers: [
      { provide: PrismaService, useValue: world.prisma },
      { provide: ShipmentProviderFactory, useValue: { get: () => undefined, getAll: () => [] } },
      ShipmentStatusMapper,
      ShipmentSyncService,
      JneWebhookService,
      { provide: JNE_WEBHOOK_CONFIG, useValue: { enabled: true, allowedSourceIps: ['110.239.85.204', '127.0.0.1'] } },
    ],
  }).compile()
  app = moduleRef.createNestApplication({ logger: false })
  // The same global HTTP setup main.ts applies to this route.
  app.setGlobalPrefix('api')
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })
  app.useGlobalGuards(new CsrfGuard())
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }))
  await app.listen(0, '127.0.0.1')
  url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/shipments/webhook/jne`
}, 180_000)

afterAll(async () => {
  await app?.close()
})

async function post(body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

/** A paid order handed to JNE: shipment CREATED with an AWB, order SHIPPED. */
async function jneShipment() {
  const scenario = await seedScenario(world, { paymentStatus: 'PAID', orderStatus: 'PROCESSING' })
  await world.prisma.order.update({ where: { id: scenario.order.id }, data: { status: OrderStatus.SHIPPED } })
  const awb = `JNE${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
  const shipment = await world.prisma.shipment.create({
    data: {
      orderId: scenario.order.id, provider: 'jne', service: 'REG', status: ShipmentStatus.CREATED, cost: 18000,
      trackingNumber: awb, providerShipmentId: awb, metadata: { jne: { pickupDatetime: '2026-09-12T10:00:00.000Z' } },
    },
  })
  return { scenario, shipment, awb, orderNumber: scenario.order.orderNumber }
}

const H = {
  pickup: { date: '2026-09-12 09:00:00', status: 'PICKED UP', status_code: 'PU1', status_desc: 'PICKED UP BY COURIER', location_code: 'BDO' },
  transit: { date: '2026-09-12 12:00:00', status: 'ON PROCESS', status_code: 'OP1', status_desc: 'MANIFESTED', location_code: 'BDO' },
  delivered: { date: '2026-09-13 10:30:00', status: 'DELIVERED', status_code: 'D01', status_desc: 'DELIVERED TO RECEIVER', location_code: 'CGK' },
}

const payload = (awb: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
  awb, order_id: orderNumber, status: 'SUCCESS PICKUP', actual_weight: '1.2', actual_ongkir: '21000', service: 'REG',
  actual_sender_name: 'Bakso Mas Sular', actual_sender_address: 'Jl. Contoh 1', goods_desc: 'Bakso', origin_code: 'BDO10000', dest_code: 'CGK10000',
  history: [H.pickup], ...over,
})

async function state(shipmentId: string, orderId: string) {
  const shipment = await world.prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })
  return {
    shipment,
    record: readJneWebhook(shipment.metadata),
    order: await world.prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    history: await world.prisma.shipmentHistory.findMany({ where: { shipmentId }, orderBy: { changedAt: 'asc' } }),
    orderEvents: await world.prisma.orderEvent.findMany({ where: { orderId, note: { startsWith: 'Shipment' } }, orderBy: { createdAt: 'asc' } }),
    outbox: await world.prisma.notificationOutbox.findMany({ where: { template: 'shipment.status', payload: { path: ['orderId'], equals: orderId } }, orderBy: { createdAt: 'asc' } }),
  }
}

describe('JNE webhook: full lifecycle on real PostgreSQL', () => {
  it('SUCCESS PICKUP → SHIPPED → DELIVERED: shipment, order, history, events and notifications', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    const sequence = [
      payload(awb, orderNumber),
      payload(awb, orderNumber, { status: 'SHIPPED', history: [H.pickup, H.transit] }),
      payload(awb, orderNumber, {
        status: 'DELIVERED', history: [H.pickup, H.transit, H.delivered], cod_amount: '0',
        receiver_name: 'Budi', receiver_relation: 'SELF', signature: 'https://img.jne.example/s.png', photo: 'https://img.jne.example/p.jpg',
      }),
    ]
    const before = new Date()
    for (const body of sequence) expect(await post(body)).toEqual({ status: 200, body: { status: true } })
    const after = new Date()

    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(s.shipment.cost).toBe(18000) // charged shipping untouched by actual_ongkir
    expect(s.order.status).toBe(OrderStatus.DELIVERED)
    expect(s.history.map((h) => [h.providerStatus, h.mappedStatus])).toEqual([
      ['SUCCESS PICKUP', ShipmentStatus.PICKED_UP],
      ['SHIPPED', ShipmentStatus.IN_TRANSIT],
      ['DELIVERED', ShipmentStatus.DELIVERED],
    ])
    // changedAt is OUR receipt time (unchanged); JNE's GMT+7 dates are stored as their own instants.
    for (const h of s.history) {
      expect(h.changedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(h.changedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    }
    expect(s.orderEvents.map((e) => e.status)).toEqual([OrderStatus.DELIVERING, OrderStatus.DELIVERED])
    expect(s.outbox.map((o) => (o.payload as { shipmentStatus: string }).shipmentStatus)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'DELIVERED'])
    expect(s.outbox.every((o) => o.status === 'PENDING')).toBe(true) // queued only - nothing sent
    expect(s.record).toMatchObject({
      actual: { weight: 1.2, ongkir: 21000, service: 'REG' },
      delivery: { receiverName: 'Budi', receiverRelation: 'SELF', signatureUrl: 'https://img.jne.example/s.png', photoUrl: 'https://img.jne.example/p.jpg', codAmount: 0 },
      lastAppliedStatus: 'DELIVERED',
      lastAppliedEventAt: '2026-09-13 10:30:00', // verbatim JNE date
      lastEventAt: '2026-09-13 10:30:00',
    })
    expect(s.record!.events.map((e) => e.statusCode)).toEqual(['PU1', 'OP1', 'D01'])
    // history[].date is GMT+7 (JNE-confirmed): persisted verbatim AND as the same instant in UTC.
    expect(s.record!.events.map((e) => [e.date, e.at])).toEqual([
      ['2026-09-12 09:00:00', '2026-09-12T02:00:00.000Z'],
      ['2026-09-12 12:00:00', '2026-09-12T05:00:00.000Z'],
      ['2026-09-13 10:30:00', '2026-09-13T03:30:00.000Z'],
    ])
    // actual_weight / actual_ongkir arrived as strings; the raw strings are persisted too.
    expect(s.record!.actual).toMatchObject({ weightRaw: '1.2', ongkirRaw: '21000' })
    expect((s.shipment.metadata as { jne: { pickupDatetime: string } }).jne.pickupDatetime).toBe('2026-09-12T10:00:00.000Z')
  })
})

describe('JNE webhook: idempotency on real PostgreSQL', () => {
  it('10 sequential + 10 CONCURRENT identical deliveries → one transition, one history row, one notification', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    const body = payload(awb, orderNumber)
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => post(body)))
    for (let i = 0; i < 10; i++) concurrent.push(await post(body))
    expect(concurrent.every((r) => r.status === 200 && r.body.status === true)).toBe(true)

    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.PICKED_UP)
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([1, 1, 1])
    expect(s.record!.events).toHaveLength(1)
    expect(s.record!.summaries).toHaveLength(1)
  })

  it('out-of-order: a late SUCCESS PICKUP after SHIPPED changes no state, adds no notification, keeps its events', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    await post(payload(awb, orderNumber, { status: 'SHIPPED', history: [H.transit] }))
    expect((await post(payload(awb, orderNumber, { history: [H.pickup] }))).body).toEqual({ status: true })
    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.IN_TRANSIT)
    expect(s.outbox).toHaveLength(1)
    expect(s.record!.events.map((e) => e.statusCode)).toEqual(['PU1', 'OP1'])
  })

  it('SHIPMENT PROBLEM is recorded without a transition or notification; a later DELIVERED still transitions', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    expect((await post(payload(awb, orderNumber, { status: 'SHIPMENT PROBLEM' }))).body).toEqual({ status: true })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect([s.history.length, s.outbox.length]).toEqual([0, 0])
    expect(s.record!.summaries.map((x) => x.status)).toEqual(['SHIPMENT PROBLEM'])

    expect((await post(payload(awb, orderNumber, { status: 'DELIVERED', history: [H.pickup, H.transit, H.delivered] }))).body).toEqual({ status: true })
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.DELIVERED)
    expect(s.order.status).toBe(OrderStatus.DELIVERED)
    expect(s.outbox.map((o) => (o.payload as { shipmentStatus: string }).shipmentStatus)).toEqual(['DELIVERED'])
  })

  it('FAILED PICKUP is a recorded attempt, not a terminal failure: a later SUCCESS PICKUP recovers the shipment', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    const attempt = { date: '2026-09-12 08:00:00', status: 'PICKUP FAILED', status_code: 'PF1', status_desc: 'SHIPPER NOT AVAILABLE', location_code: 'BDO' }
    expect((await post(payload(awb, orderNumber, { status: 'FAILED PICKUP', history: [attempt] }))).body).toEqual({ status: true })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect([s.history.length, s.outbox.length]).toEqual([0, 0])

    expect((await post(payload(awb, orderNumber, { history: [attempt, H.pickup] }))).body).toEqual({ status: true })
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.PICKED_UP)
    expect(s.outbox.map((o) => (o.payload as { shipmentStatus: string }).shipmentStatus)).toEqual(['PICKED_UP'])
    expect(s.record!.events.map((e) => e.statusCode)).toEqual(['PF1', 'PU1'])
  })
})

describe('JNE webhook: refusals and atomicity on real PostgreSQL', () => {
  it('unknown AWB → 404 and order_id mismatch → 409; nothing is created or modified', async () => {
    const { shipment, scenario, awb } = await jneShipment()
    const before = await world.prisma.shipment.count()
    expect(await post(payload('JNE-DOES-NOT-EXIST', 'BMS-X'))).toEqual({ status: 404, body: { status: false, reason: 'unknown awb: no JNE shipment has this awb' } })
    expect(await post(payload(awb, 'BMS-SOMEONE-ELSE'))).toEqual({ status: 409, body: { status: false, reason: 'order_id does not match the shipment for this awb' } })
    expect(await world.prisma.shipment.count()).toBe(before)
    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect(s.record).toBeUndefined()
    expect([s.history.length, s.outbox.length]).toEqual([0, 0])
  })

  it('a failure inside the transition rolls back EVERYTHING (500); the retry applies exactly once', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    // Fails while building the notification - after the status CAS, history row and
    // order advance were already written inside the same transaction.
    const label = jest.spyOn(ShipmentStatusMapper.prototype, 'label').mockImplementationOnce(() => {
      throw new Error('simulated failure mid-transition')
    })
    expect(await post(payload(awb, orderNumber))).toEqual({ status: 500, body: { status: false, reason: 'internal error' } })
    let s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.CREATED)
    expect(s.order.status).toBe(OrderStatus.SHIPPED)
    expect(s.record).toBeUndefined()
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([0, 0, 0])
    label.mockRestore()

    expect(await post(payload(awb, orderNumber))).toEqual({ status: 200, body: { status: true } })
    s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.PICKED_UP)
    expect([s.history.length, s.orderEvents.length, s.outbox.length]).toEqual([1, 1, 1])
  })
})

describe('JNE webhook data vs the pollers and admin edits (real PostgreSQL)', () => {
  it('a stale poll (IN_TRANSIT → PICKED_UP) is rejected and recorded; the JNE webhook record is untouched', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    await post(payload(awb, orderNumber, { status: 'SHIPPED', history: [H.pickup, H.transit] }))
    const webhookBefore = (await state(shipment.id, scenario.order.id)).record

    // The tracking poller, answered from a stale cache: the courier still says PICKED_UP.
    // Answers ONLY for this test's AWB: the shared test database holds other specs'
    // shipments, which must not be touched (the poller isolates per-shipment errors).
    const courier = {
      name: 'jne',
      trackShipmentRaw: async (tracking: string) => {
        if (tracking !== awb) throw new Error('not the shipment under test')
        return { providerStatus: 'PICKED_UP', rawPayload: {} }
      },
    }
    const poller = new ShipmentSyncService(world.prisma, { get: () => courier, getAll: () => [courier] } as never, new ShipmentStatusMapper())
    await poller.syncAll(500)
    await poller.syncAll(500) // same stale answer again: recorded once

    const s = await state(shipment.id, scenario.order.id)
    expect(s.shipment.status).toBe(ShipmentStatus.IN_TRANSIT)
    expect(s.history.map((h) => h.mappedStatus)).toEqual([ShipmentStatus.IN_TRANSIT])
    expect(s.outbox).toHaveLength(1)
    expect(readShipmentMetadata(s.shipment.metadata).tracking?.rejected).toEqual([
      expect.objectContaining({ provider: 'jne', providerStatus: 'PICKED_UP', shipmentStatus: 'IN_TRANSIT', reason: 'would_regress' }),
    ])
    expect(s.record).toEqual(webhookBefore)
  })

  it('an unrelated admin metadata edit keeps jne.webhook and every other namespace', async () => {
    const { shipment, scenario, awb, orderNumber } = await jneShipment()
    await post(payload(awb, orderNumber))
    const before = await state(shipment.id, scenario.order.id)

    await world.admin.updateShipment(shipment.id, { metadata: { opsNote: 'call receiver before 17:00' } } as never)

    const after = await state(shipment.id, scenario.order.id)
    expect(after.record).toEqual(before.record)
    const metadata = after.shipment.metadata as { jne: { pickupDatetime: string }; opsNote: string }
    expect(metadata.jne.pickupDatetime).toBe('2026-09-12T10:00:00.000Z')
    expect(metadata.opsNote).toBe('call receiver before 17:00')
  })
})
