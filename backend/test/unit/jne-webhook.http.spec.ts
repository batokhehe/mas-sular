import { Global, INestApplication, Logger, Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { AddressInfo } from 'net';
import { CsrfGuard } from '../../src/common/auth/csrf.guard';
import { PrismaService } from '../../src/database/prisma.service';
import { LogService } from '../../src/infrastructure/logging/log.service';
import { JNE_WEBHOOK_CONFIG } from '../../src/modules/shipment/jne-webhook.config';
import { JneWebhookService } from '../../src/modules/shipment/jne-webhook.service';
import { JneWebhookController } from '../../src/modules/shipment/presentation/jne-webhook.controller';
import { readJneWebhook } from '../../src/modules/shipment/shipment-metadata';
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { ShipmentModule } from '../../src/modules/shipment/shipment.module';
import { MetricsModule } from '../../src/infrastructure/metrics/metrics.module';

/**
 * JNE Webhook Status V2 through the REAL NestJS HTTP route: real controller, real
 * JneWebhookService, real ShipmentSyncService.applyTransitionInTx and mapper, the
 * same global CsrfGuard / ValidationPipe / throttler as main.ts. The database is an
 * in-memory Prisma double that honours what the code relies on: CAS updateMany,
 * transactional ROLLBACK on error, and serialization of transactions (the row lock).
 * The same flows run against real PostgreSQL in test/integration/jne-webhook.int-spec.ts.
 */
const HTTP_TEST_TIMEOUT_MS = 30_000;
const AWB = 'JNE0001';
const ORDER_NUMBER = 'BMS-20260912-001';

type Row = Record<string, any>;

function fakeDb() {
  const state = {
    orders: new Map<string, Row>(),
    shipments: new Map<string, Row>(),
    history: [] as Row[],
    orderEvents: [] as Row[],
    outbox: [] as Row[],
    locks: [] as string[],
    failOutbox: false,
  };
  const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const snapshot = () => clone({ orders: [...state.orders], shipments: [...state.shipments], history: state.history, orderEvents: state.orderEvents, outbox: state.outbox });
  const restore = (s: ReturnType<typeof snapshot>) => {
    state.orders = new Map(s.orders);
    state.shipments = new Map(s.shipments);
    state.history = s.history;
    state.orderEvents = s.orderEvents;
    state.outbox = s.outbox;
  };
  let chain = Promise.resolve();

  const client: Row = {
    shipment: {
      findMany: async ({ where, take }: Row) =>
        [...state.shipments.values()]
          .filter((s) => s.trackingNumber === where.trackingNumber && s.provider.toLowerCase() === String(where.provider.equals).toLowerCase())
          .slice(0, take)
          .map((s) => ({ id: s.id, order: { orderNumber: state.orders.get(s.orderId)!.orderNumber } })),
      findUnique: async ({ where }: Row) => {
        const s = state.shipments.get(where.id);
        return s ? clone({ ...s, order: state.orders.get(s.orderId) }) : null;
      },
      updateMany: async ({ where, data }: Row) => {
        const s = state.shipments.get(where.id);
        if (!s || s.status !== where.status) return { count: 0 };
        Object.assign(s, clone(data));
        return { count: 1 };
      },
      update: async ({ where, data }: Row) => {
        const s = state.shipments.get(where.id)!;
        Object.assign(s, clone(data));
        return clone(s);
      },
      count: async () => state.shipments.size,
    },
    shipmentHistory: { create: async ({ data }: Row) => state.history.push(clone(data)) },
    // Read by JneOriginBootValidator at bootstrap (module wiring test): an empty master.
    jneLocation: { count: async () => 0, findFirst: async () => null },
    order: {
      updateMany: async ({ where, data }: Row) => {
        const o = state.orders.get(where.id);
        if (!o || !where.status.in.includes(o.status)) return { count: 0 };
        o.status = data.status;
        return { count: 1 };
      },
    },
    orderEvent: { create: async ({ data }: Row) => state.orderEvents.push(clone(data)) },
    notificationOutbox: {
      create: async ({ data }: Row) => {
        if (state.failOutbox) throw new Error('notification outbox unavailable');
        state.outbox.push(clone(data));
      },
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.locks.push(String(values[0]));
      return [];
    },
    // Serialized (the row lock) and all-or-nothing (rollback on any error).
    $transaction: (cb: (tx: Row) => Promise<unknown>) => {
      const run = chain.then(async () => {
        const before = snapshot();
        try {
          return await cb(client);
        } catch (err) {
          restore(before);
          throw err;
        }
      });
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
  };

  const seed = (over: { status?: ShipmentStatus; orderStatus?: OrderStatus } = {}) => {
    state.orders.set('o1', {
      id: 'o1', orderNumber: ORDER_NUMBER, status: over.orderStatus ?? OrderStatus.SHIPPED,
      shippingService: 'REG', shippingServiceName: 'JNE REG',
      user: { name: 'Jane', email: 'jane@test.invalid', phone: '0812000' }, address: { phone: '0812000' },
    });
    state.shipments.set('s1', {
      id: 's1', orderId: 'o1', provider: 'jne', service: 'REG', status: over.status ?? ShipmentStatus.CREATED,
      cost: 18000, trackingNumber: AWB, providerPayload: { cnote: AWB },
      metadata: { jne: { pickupDatetime: '2026-09-12T10:00:00.000Z' } },
    });
    // Another courier's shipment carrying the same airwaybill string: never touched.
    state.orders.set('o2', { id: 'o2', orderNumber: 'BMS-OTHER', status: OrderStatus.SHIPPED, user: null, address: null });
    state.shipments.set('s2', { id: 's2', orderId: 'o2', provider: 'paxel', service: 'X', status: ShipmentStatus.CREATED, cost: 1, trackingNumber: 'PXL1', metadata: null });
  };
  return { state, client, seed };
}

const HISTORY = {
  pickup: { date: '2026-09-12 09:00:00', status: 'PICKED UP', status_code: 'PU1', status_desc: 'PICKED UP BY COURIER', location_code: 'BDO' },
  transit: { date: '2026-09-12 12:00:00', status: 'ON PROCESS', status_code: 'OP1', status_desc: 'MANIFESTED', location_code: 'BDO' },
  transit2: { date: '2026-09-12 18:00:00', status: 'ON PROCESS', status_code: 'OP1', status_desc: 'RECEIVED AT WAREHOUSE', location_code: 'CGK' },
  delivered: { date: '2026-09-13 10:30:00', status: 'DELIVERED', status_code: 'D01', status_desc: 'DELIVERED TO RECEIVER', location_code: 'CGK' },
};

const payload = (over: Record<string, unknown> = {}) => ({
  awb: AWB,
  order_id: ORDER_NUMBER,
  status: 'SUCCESS PICKUP',
  actual_weight: '1.2',
  actual_ongkir: '21000',
  service: 'REG',
  actual_sender_name: 'Bakso Mas Sular',
  actual_sender_address: 'Jl. Contoh No. 1, Bandung',
  goods_desc: 'Bakso beku',
  origin_code: 'BDO10000',
  dest_code: 'CGK10000',
  actual_receiver_address: 'Jl. Penerima 9, Jakarta',
  actual_receiver_city_name: 'JAKARTA',
  actual_receiver_city_code: 'CGK10000',
  latitude: '-6.2',
  longitude: '106.8',
  history: [HISTORY.pickup],
  ...over,
});

const delivered = (over: Record<string, unknown> = {}) =>
  payload({
    status: 'DELIVERED',
    receiver_name: 'Budi Penerima',
    receiver_relation: 'SELF',
    signature: 'https://img.jne.example/signature/JNE0001.png',
    photo: 'https://img.jne.example/pod/JNE0001.jpg',
    history: [HISTORY.pickup, HISTORY.transit, HISTORY.delivered],
    ...over,
  });

describe('JNE Webhook Status V2 - POST /api/v1/shipments/webhook/jne', () => {
  let app: INestApplication;
  let db: ReturnType<typeof fakeDb>;
  let cache: { del: jest.Mock; get: jest.Mock; set: jest.Mock };
  let logWrites: jest.Mock;
  let loggerLines: unknown[];

  async function boot(enabled = true) {
    db = fakeDb();
    db.seed();
    cache = { del: jest.fn().mockResolvedValue(undefined), get: jest.fn(), set: jest.fn() };
    logWrites = jest.fn();
    loggerLines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(((line: unknown) => { loggerLines.push(line); }) as never);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
      controllers: [JneWebhookController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: PrismaService, useValue: db.client },
        { provide: ShipmentProviderFactory, useValue: { get: () => undefined, getAll: () => [] } },
        ShipmentStatusMapper,
        ShipmentSyncService,
        JneWebhookService,
        { provide: JNE_WEBHOOK_CONFIG, useValue: { enabled } },
        { provide: LogService, useValue: { write: logWrites } },
        { provide: CACHE_MANAGER, useValue: cache },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    // Exactly the global HTTP setup of main.ts that this route passes through.
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalGuards(new CsrfGuard());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } }));
    await app.listen(0, '127.0.0.1');
  }

  async function post(body: unknown, contentType = 'application/json') {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/jne`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const shipment = () => db.state.shipments.get('s1')!;
  const order = () => db.state.orders.get('o1')!;
  const record = () => readJneWebhook(shipment().metadata)!;

  beforeEach(async () => boot(), HTTP_TEST_TIMEOUT_MS);
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  }, HTTP_TEST_TIMEOUT_MS);

  it('A. SUCCESS PICKUP → PICKED_UP, order DELIVERING, one history row + one notification, documented 200 body', async () => {
    const before = Date.now();
    expect(await post(payload())).toEqual({ status: 200, body: { status: true } });
    const after = Date.now();
    expect(shipment().status).toBe(ShipmentStatus.PICKED_UP);
    expect(order().status).toBe(OrderStatus.DELIVERING);
    expect(db.state.history).toEqual([
      expect.objectContaining({ shipmentId: 's1', providerStatus: 'SUCCESS PICKUP', mappedStatus: ShipmentStatus.PICKED_UP }),
    ]);
    // changedAt is OUR receipt time - JNE's date has no documented zone to convert from.
    const changedAt = new Date(db.state.history[0].changedAt).getTime();
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(after);
    expect(record().lastAppliedEventAt).toBe('2026-09-12 09:00:00'); // verbatim JNE date
    expect(db.state.orderEvents).toEqual([expect.objectContaining({ orderId: 'o1', status: OrderStatus.DELIVERING })]);
    expect(db.state.outbox).toHaveLength(1);
    expect(db.state.outbox[0]).toMatchObject({ template: 'shipment.status', payload: { shipmentStatus: ShipmentStatus.PICKED_UP, trackingNumber: AWB, orderNumber: ORDER_NUMBER } });
    expect(db.state.locks).toEqual(['s1']); // processed under the shipment row lock
    expect(cache.del).toHaveBeenCalledWith(`shipment:tracking:jne:${AWB}`);
  }, HTTP_TEST_TIMEOUT_MS);

  it('B. FAILED PICKUP is a recorded pickup ATTEMPT, not a terminal failure: no transition, no notification', async () => {
    const failedAttempt = { date: '2026-09-12 08:00:00', status: 'PICKUP FAILED', status_code: 'PF1', status_desc: 'SHIPPER NOT AVAILABLE', location_code: 'BDO' };
    expect((await post(payload({ status: 'FAILED PICKUP', history: [failedAttempt] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.CREATED); // still tracked, not FAILED
    expect(order().status).toBe(OrderStatus.SHIPPED);
    expect([db.state.history.length, db.state.orderEvents.length, db.state.outbox.length]).toEqual([0, 0, 0]);
    expect(record().summaries.map((x) => x.status)).toEqual(['FAILED PICKUP']);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.failed_pickup', transition: 'unmapped_status' }));

    // JNE re-attempts: the later SUCCESS PICKUP recovers the shipment normally.
    expect((await post(payload({ history: [failedAttempt, HISTORY.pickup] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.PICKED_UP);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.PICKED_UP]);
    expect(record().events.map((e) => e.statusCode)).toEqual(['PF1', 'PU1']);
  }, HTTP_TEST_TIMEOUT_MS);

  it('C. SHIPPED → IN_TRANSIT', async () => {
    expect((await post(payload({ status: 'SHIPPED', history: [HISTORY.pickup, HISTORY.transit] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(order().status).toBe(OrderStatus.DELIVERING);
  }, HTTP_TEST_TIMEOUT_MS);

  it('D. DELIVERED stores receiver, relation, signature and photo URLs; order DELIVERED; nothing fetched', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    expect((await post(delivered())).body).toEqual({ status: true });
    const outboundCalls = fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith('http://127.0.0.1'));
    expect(outboundCalls).toEqual([]); // media are stored as links, never downloaded
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(order().status).toBe(OrderStatus.DELIVERED);
    expect(record().delivery).toEqual({
      receiverName: 'Budi Penerima',
      receiverRelation: 'SELF',
      signatureUrl: 'https://img.jne.example/signature/JNE0001.png',
      photoUrl: 'https://img.jne.example/pod/JNE0001.jpg',
    });
    expect(record().route).toMatchObject({ receiverAddress: 'Jl. Penerima 9, Jakarta', receiverCityName: 'JAKARTA', latitude: -6.2, longitude: 106.8 });
    expect(shipment().metadata.jne.pickupDatetime).toBe('2026-09-12T10:00:00.000Z'); // other metadata kept
  }, HTTP_TEST_TIMEOUT_MS);

  it('E. SHIPMENT PROBLEM: accepted and recorded, but NO transition, history row or notification', async () => {
    expect((await post(payload({ status: 'SHIPMENT PROBLEM', history: [HISTORY.pickup, HISTORY.transit] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(db.state.history).toHaveLength(0);
    expect(db.state.outbox).toHaveLength(0);
    expect(record().summaries.map((s) => s.status)).toEqual(['SHIPMENT PROBLEM']);
    expect(record().events).toHaveLength(2);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.shipment_problem', transition: 'unmapped_status' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('E. after a SHIPMENT PROBLEM the lifecycle continues: a later DELIVERED transitions normally', async () => {
    await post(payload({ status: 'SHIPPED', history: [HISTORY.pickup, HISTORY.transit] }));
    await post(payload({ status: 'SHIPMENT PROBLEM', history: [HISTORY.pickup, HISTORY.transit, HISTORY.transit2] }));
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT); // not failed, not moved
    expect((await post(delivered({ history: [HISTORY.pickup, HISTORY.transit, HISTORY.transit2, HISTORY.delivered] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(order().status).toBe(OrderStatus.DELIVERED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED]);
    expect(record().summaries.map((x) => x.status)).toEqual(['SHIPPED', 'SHIPMENT PROBLEM', 'DELIVERED']);
  }, HTTP_TEST_TIMEOUT_MS);

  it('F. RETURN TO SHIPPER → FAILED, notified once', async () => {
    await post(payload({ status: 'SHIPPED', history: [HISTORY.pickup, HISTORY.transit] }));
    expect((await post(payload({ status: 'RETURN TO SHIPPER', history: [HISTORY.pickup, HISTORY.transit, HISTORY.transit2] }))).body).toEqual({ status: true });
    expect(shipment().status).toBe(ShipmentStatus.FAILED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.IN_TRANSIT, ShipmentStatus.FAILED]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('G. a missing mandatory field → 400 with the documented failure body, nothing written', async () => {
    const res = await post(payload({ goods_desc: undefined }));
    expect(res).toEqual({ status: 400, body: { status: false, reason: 'goods_desc is required' } });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(shipment().metadata).toEqual({ jne: { pickupDatetime: '2026-09-12T10:00:00.000Z' } });
    expect(db.state.locks).toEqual([]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('H. an undocumented status → 400', async () => {
    const res = await post(payload({ status: 'IN TRANSIT' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ status: false, reason: expect.stringMatching(/^status must be one of: SUCCESS PICKUP, FAILED PICKUP/) });
  }, HTTP_TEST_TIMEOUT_MS);

  it('I. a malformed history date → 400', async () => {
    const res = await post(payload({ history: [{ ...HISTORY.pickup, date: '12/09/2026 09:00' }] }));
    expect(res).toEqual({ status: 400, body: { status: false, reason: 'history[0].date must be YYYY-MM-DD HH:MM:SS' } });
  }, HTTP_TEST_TIMEOUT_MS);

  it('J. unknown AWB (and another courier\'s AWB) → 404, nothing created', async () => {
    expect(await post(payload({ awb: 'NOPE999' }))).toEqual({ status: 404, body: { status: false, reason: 'unknown awb: no JNE shipment has this awb' } });
    expect((await post(payload({ awb: 'PXL1' }))).status).toBe(404); // a Paxel shipment is never touched
    expect(db.state.shipments.size).toBe(2);
    expect(db.state.shipments.get('s2')!.status).toBe(ShipmentStatus.CREATED);
    expect(db.state.history).toHaveLength(0);
  }, HTTP_TEST_TIMEOUT_MS);

  it('K. order_id that does not match the AWB\'s shipment → 409, nothing written', async () => {
    const res = await post(payload({ order_id: 'BMS-OTHER' }));
    expect(res).toEqual({ status: 409, body: { status: false, reason: 'order_id does not match the shipment for this awb' } });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(db.state.orders.get('o2')!.status).toBe(OrderStatus.SHIPPED);
    expect(db.state.outbox).toHaveLength(0);
  }, HTTP_TEST_TIMEOUT_MS);

  it('L. an identical webhook retried → 200 each time, side effects exactly once, metadata unchanged', async () => {
    await post(payload());
    const afterFirst = JSON.stringify(shipment());
    cache.del.mockClear();
    for (let i = 0; i < 5; i++) expect(await post(payload())).toEqual({ status: 200, body: { status: true } });
    expect(JSON.stringify(shipment())).toBe(afterFirst);
    expect(db.state.history).toHaveLength(1);
    expect(db.state.orderEvents).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
    expect(cache.del).not.toHaveBeenCalled();
    expect(loggerLines.filter((l: any) => l?.event === 'jne.webhook.duplicate')).toHaveLength(5);
  }, HTTP_TEST_TIMEOUT_MS);

  it('M. a duplicated history entry is stored once; the same status_code at another time is kept', async () => {
    await post(payload({ status: 'SHIPPED', history: [HISTORY.transit, HISTORY.transit, HISTORY.transit2, HISTORY.pickup] }));
    const codes = record().events.map((e) => [e.statusCode, e.date]);
    expect(codes).toEqual([['PU1', '2026-09-12 09:00:00'], ['OP1', '2026-09-12 12:00:00'], ['OP1', '2026-09-12 18:00:00']]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('N. out-of-order: a late SUCCESS PICKUP / RETURN TO SHIPPER never moves a shipped parcel, but its events are kept', async () => {
    await post(payload({ status: 'SHIPPED', history: [HISTORY.transit] }));
    await post(payload({ status: 'SUCCESS PICKUP', history: [HISTORY.pickup] }));
    // A return dated BEFORE the event that already moved the shipment: stale, not applied.
    await post(payload({ status: 'RETURN TO SHIPPER', history: [HISTORY.pickup] }));
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(db.state.history.map((h) => h.mappedStatus)).toEqual([ShipmentStatus.IN_TRANSIT]);
    expect(db.state.outbox).toHaveLength(1);
    expect(record().events.map((e) => e.statusCode)).toEqual(['PU1', 'OP1']); // chronological, nothing lost
    expect(record().summaries.map((s) => s.status)).toEqual(['SHIPPED', 'SUCCESS PICKUP', 'RETURN TO SHIPPER']);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.processed', transition: 'stale', jneStatus: 'SUCCESS PICKUP' }));
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.processed', transition: 'stale', jneStatus: 'RETURN TO SHIPPER' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('N. a DELIVERED shipment is terminal: a later SHIPPED push changes nothing', async () => {
    await post(delivered());
    await post(payload({ status: 'SHIPPED', history: [HISTORY.pickup, HISTORY.transit, HISTORY.delivered, { ...HISTORY.transit2, date: '2026-09-14 08:00:00' }] }));
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(order().status).toBe(OrderStatus.DELIVERED);
    expect(db.state.outbox).toHaveLength(1);
  }, HTTP_TEST_TIMEOUT_MS);

  it('O. multiple history entries: stored chronologically (verbatim dates); the webhook speaks for the latest entry', async () => {
    await post(delivered({ history: [HISTORY.delivered, HISTORY.pickup, HISTORY.transit2, HISTORY.transit] }));
    expect(record().events.map((e) => e.date)).toEqual(['2026-09-12 09:00:00', '2026-09-12 12:00:00', '2026-09-12 18:00:00', '2026-09-13 10:30:00']);
    expect(record().lastEventAt).toBe('2026-09-13 10:30:00');
    expect(record().lastAppliedEventAt).toBe('2026-09-13 10:30:00');
  }, HTTP_TEST_TIMEOUT_MS);

  it('P. DELIVERED with COD: cod_amount kept as courier information only - no payment or order financial change', async () => {
    expect((await post(delivered({ cod_amount: '150000' }))).body).toEqual({ status: true });
    expect(record().delivery).toMatchObject({ codAmount: 150000, codAmountRaw: '150000' });
    // The Prisma double exposes no payment model: any payment write would have thrown.
    expect(db.client.payment).toBeUndefined();
    expect(order().status).toBe(OrderStatus.DELIVERED);
  }, HTTP_TEST_TIMEOUT_MS);

  it('Q. actual_weight / actual_ongkir are stored as courier figures; Shipment.cost (charged) is untouched', async () => {
    await post(payload({ actual_weight: '1.25', actual_ongkir: '22500.00' }));
    expect(record().actual).toEqual({ weight: 1.25, weightRaw: '1.25', ongkir: 22500, ongkirRaw: '22500.00', service: 'REG' });
    expect(shipment().cost).toBe(18000);
  }, HTTP_TEST_TIMEOUT_MS);

  it('R. a failure mid-transition rolls everything back (500 documented body); the retry then applies exactly once', async () => {
    db.state.failOutbox = true;
    const failed = await post(delivered());
    expect(failed).toEqual({ status: 500, body: { status: false, reason: 'internal error' } });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(order().status).toBe(OrderStatus.SHIPPED);
    expect(shipment().metadata).toEqual({ jne: { pickupDatetime: '2026-09-12T10:00:00.000Z' } });
    expect(db.state.history).toHaveLength(0);
    expect(db.state.orderEvents).toHaveLength(0);

    db.state.failOutbox = false;
    expect(await post(delivered())).toEqual({ status: 200, body: { status: true } });
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect([db.state.history.length, db.state.orderEvents.length, db.state.outbox.length]).toEqual([1, 1, 1]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('S. a full lifecycle with every webhook retried (sequential and concurrent) notifies exactly once per transition', async () => {
    const sequence = [
      payload(),
      payload({ status: 'SHIPPED', history: [HISTORY.pickup, HISTORY.transit] }),
      delivered(),
    ];
    for (const body of sequence) {
      await Promise.all([post(body), post(body), post(body)]);
      await post(body);
    }
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.DELIVERED]);
    expect(db.state.history).toHaveLength(3);
    expect(db.state.orderEvents.map((e) => e.status)).toEqual([OrderStatus.DELIVERING, OrderStatus.DELIVERED]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('undocumented extra fields pass the strict global ValidationPipe (no 400 retry loop)', async () => {
    expect(await post(payload({ future_field: 'x', nested: { a: 1 } }))).toEqual({ status: 200, body: { status: true } });
  }, HTTP_TEST_TIMEOUT_MS);

  it('only application/json is consumed (415 documented body otherwise)', async () => {
    const res = await post('awb=JNE0001', 'application/x-www-form-urlencoded');
    expect(res).toEqual({ status: 415, body: { status: false, reason: 'Content-Type must be application/json' } });
    expect(db.state.locks).toEqual([]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('logs correlators and outcomes, never the payload or customer PII', async () => {
    await post(delivered({ cod_amount: '150000' }));
    await post(payload({ goods_desc: undefined }));
    const logged = JSON.stringify([loggerLines, logWrites.mock.calls]);
    for (const pii of ['Budi Penerima', 'Jl. Penerima', 'Jl. Contoh', 'img.jne.example', 'Bakso beku', '-6.2', '0812000']) {
      expect(logged).not.toContain(pii);
    }
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.received', awb: AWB, orderId: ORDER_NUMBER, jneStatus: 'DELIVERED' }));
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.processed', outcome: 'transitioned', transition: 'applied', from: 'CREATED', to: 'DELIVERED' }));
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'jne.webhook.validation_failed', reason: 'goods_desc is required' }));
  }, HTTP_TEST_TIMEOUT_MS);
});

describe('JNE webhook disabled (the default)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  it('answers 503 with the documented failure body and touches nothing', async () => {
    const db = fakeDb();
    db.seed();
    const moduleRef = await Test.createTestingModule({
      controllers: [JneWebhookController],
      providers: [
        { provide: PrismaService, useValue: db.client },
        { provide: ShipmentProviderFactory, useValue: {} },
        ShipmentStatusMapper,
        ShipmentSyncService,
        JneWebhookService,
        { provide: JNE_WEBHOOK_CONFIG, useValue: { enabled: false } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/jne`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: false, reason: 'JNE webhook is not enabled' });
    expect(db.state.shipments.get('s1')!.status).toBe(ShipmentStatus.CREATED);
    expect(db.state.locks).toEqual([]);
  }, HTTP_TEST_TIMEOUT_MS);
});

describe('ShipmentModule wiring (the real module, as main.ts boots it)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  it('resolves JneWebhookService from the module and serves POST /api/v1/shipments/webhook/jne', async () => {
    const db = fakeDb();
    db.seed();
    // Stand-ins for the GLOBAL infrastructure modules the real app provides.
    @Global()
    @Module({
      providers: [
        { provide: PrismaService, useValue: db.client },
        { provide: LogService, useValue: { write: jest.fn() } },
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
      exports: [PrismaService, LogService, CACHE_MANAGER],
    })
    class GlobalStubs {}

    const moduleRef = await Test.createTestingModule({ imports: [GlobalStubs, MetricsModule, ShipmentModule] })
      .overrideProvider(JNE_WEBHOOK_CONFIG)
      .useValue({ enabled: true })
      .compile();
    expect(moduleRef.get(JneWebhookService)).toBeInstanceOf(JneWebhookService);
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/jne`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
    });
    expect([res.status, await res.json()]).toEqual([200, { status: true }]);
    expect(db.state.shipments.get('s1')!.status).toBe(ShipmentStatus.PICKED_UP);
  }, HTTP_TEST_TIMEOUT_MS);
});
