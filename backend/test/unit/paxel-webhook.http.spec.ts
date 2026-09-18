import { Global, INestApplication, Logger, Module, ValidationPipe, VersioningType } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { LoggerModule } from 'nestjs-pino';
import { AddressInfo } from 'net';
import { Writable } from 'stream';
import { CsrfGuard } from '../../src/common/auth/csrf.guard';
import { PINO_HTTP_REDACT } from '../../src/common/logging/redact';
import { PrismaService } from '../../src/database/prisma.service';
import { LogService } from '../../src/infrastructure/logging/log.service';
import { MetricsModule } from '../../src/infrastructure/metrics/metrics.module';
import { paxelWebhookSignature } from '../../src/modules/shipment/infrastructure/providers/paxel-signature';
import { PAXEL_WEBHOOK_CONFIG } from '../../src/modules/shipment/paxel-webhook.config';
import { PaxelWebhookService } from '../../src/modules/shipment/paxel-webhook.service';
import { PaxelWebhookController } from '../../src/modules/shipment/presentation/paxel-webhook.controller';
import { readPaxelWebhook } from '../../src/modules/shipment/shipment-metadata';
import { ShipmentProviderFactory } from '../../src/modules/shipment/shipment-provider.factory';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { ShipmentModule } from '../../src/modules/shipment/shipment.module';

/**
 * Paxel webhook through the REAL NestJS HTTP route: real controller, real
 * PaxelWebhookService, real ShipmentSyncService.applyTransitionInTx and mapper, the
 * same global CsrfGuard / ValidationPipe / throttler as main.ts. The database is an
 * in-memory Prisma double honouring what the code relies on: CAS updateMany,
 * transactional ROLLBACK on error, and serialized transactions (the row lock). The
 * same flows run against real PostgreSQL in test/integration/paxel-webhook.int-spec.ts.
 * No Paxel endpoint exists here: nothing can be called.
 */
const HTTP_TEST_TIMEOUT_MS = 30_000;
const SECRET = 'test-only-paxel-webhook-secret';
const AWB = 'MERCHANT-20260913-1-KDDAFC';
const ORDER_NUMBER = 'BMS-20260913-001';

type Row = Record<string, any>;

function fakeDb() {
  const state = {
    orders: new Map<string, Row>(),
    shipments: new Map<string, Row>(),
    history: [] as Row[],
    orderEvents: [] as Row[],
    outbox: [] as Row[],
    locks: [] as string[],
    lookups: 0,
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
      findMany: async ({ where, take }: Row) => {
        state.lookups += 1;
        return [...state.shipments.values()]
          .filter((s) => s.trackingNumber === where.trackingNumber && s.provider.toLowerCase() === String(where.provider.equals).toLowerCase())
          .slice(0, take)
          .map((s) => ({ id: s.id, order: { orderNumber: state.orders.get(s.orderId)!.orderNumber } }));
      },
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
      shippingService: 'PAXEL_SAMEDAY', shippingServiceName: 'Paxel Sameday',
      user: { name: 'Jane', email: 'jane@test.invalid', phone: '0812000' }, address: { phone: '0812000' },
    });
    state.shipments.set('s1', {
      id: 's1', orderId: 'o1', provider: 'paxel', service: 'PAXEL_SAMEDAY', status: over.status ?? ShipmentStatus.CREATED,
      cost: 18000, trackingNumber: AWB, providerPayload: { data: { airwaybill_code: AWB } },
      metadata: { paxel: { pickupDatetime: '2026-09-13T10:00:00.000Z' } },
    });
    // Another courier's shipment: a Paxel push for its AWB must never touch it.
    state.orders.set('o2', { id: 'o2', orderNumber: 'BMS-OTHER', status: OrderStatus.SHIPPED, user: null, address: null });
    state.shipments.set('s2', { id: 's2', orderId: 'o2', provider: 'jne', service: 'REG', status: ShipmentStatus.CREATED, cost: 1, trackingNumber: 'JNE0001', metadata: null });
  };
  return { state, client, seed };
}

const MEDIA = {
  photo: 'https://media.paxel.example/photo.jpg',
  signature: 'https://media.paxel.example/signature.png',
  pdo_photo: 'https://media.paxel.example/pdo/photo.jpg',
  pdo_signature: 'https://media.paxel.example/pdo/signature.png',
};

/** A push shaped like the supplied Paxel example; `time` is its logs.created_datetime. */
const push = (status: string, time = '2026-09-13 10:00:00', over: Record<string, unknown> = {}) => ({
  actual_price: 50000,
  actual_weight: 1000,
  airwaybill_code: AWB,
  cancellation_reason: '',
  delivery_datetime: '2026-09-13 14:00:00',
  driver_name: 'Heri',
  invoice_number: ORDER_NUMBER,
  latest_status: status,
  logs: {
    address: 'Muara karang Blok 7', city: 'KOTA JAKARTA UTARA', created_datetime: time, district: 'Penjaringan',
    latitude: -6.1799, longitude: 106.581593, name: '-', note: `status ${status}`, province: 'DKI JAKARTA', status,
  },
  money: { bill_note: 'Uang yang diterima asli', collect_money: 10000.123 },
  receiver_name: 'Richardo Moren Silaholo',
  sender_name: 'Jhon Doe',
  items: [{ code: 'SKU0000000001', name: 'Samsung J9', category: 'Handphone', special_insurance: false }],
  ...over,
});

const delivered = (over: Record<string, unknown> = {}) => push('PDO', '2026-09-13 15:00:00', { ...MEDIA, ...over });

const sign = (body: Row, secret = SECRET) => paxelWebhookSignature(String(body.airwaybill_code), String(body.latest_status), secret);

describe('Paxel webhook - POST /api/v1/shipments/webhook/paxel', () => {
  let app: INestApplication;
  let db: ReturnType<typeof fakeDb>;
  let cache: { del: jest.Mock; get: jest.Mock; set: jest.Mock };
  let logWrites: jest.Mock;
  let loggerLines: unknown[];

  async function boot(config: { enabled: boolean; secret?: string } = { enabled: true, secret: SECRET }) {
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
      controllers: [PaxelWebhookController],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: PrismaService, useValue: db.client },
        { provide: ShipmentProviderFactory, useValue: { get: () => undefined, getAll: () => [] } },
        ShipmentStatusMapper,
        ShipmentSyncService,
        PaxelWebhookService,
        { provide: PAXEL_WEBHOOK_CONFIG, useValue: config },
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

  async function post(body: unknown, opts: { signature?: string | null; contentType?: string } = {}) {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const headers: Record<string, string> = { 'Content-Type': opts.contentType ?? 'application/json' };
    const signature = opts.signature === undefined ? (typeof body === 'object' && body ? sign(body as Row) : undefined) : opts.signature;
    if (signature) headers['X-Paxel-Signature'] = signature;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/paxel`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const shipment = () => db.state.shipments.get('s1')!;
  const order = () => db.state.orders.get('o1')!;
  const record = () => readPaxelWebhook(shipment().metadata)!;
  const untouched = () => {
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(shipment().metadata).toEqual({ paxel: { pickupDatetime: '2026-09-13T10:00:00.000Z' } });
    expect([db.state.history.length, db.state.orderEvents.length, db.state.outbox.length]).toEqual([0, 0, 0]);
  };

  beforeEach(async () => boot(), HTTP_TEST_TIMEOUT_MS);
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  }, HTTP_TEST_TIMEOUT_MS);

  it('a valid POL push → IN_TRANSIT, order DELIVERING, one history row + one notification, 200 { received: true }', async () => {
    const before = Date.now();
    expect(await post(push('POL'))).toEqual({ status: 200, body: { received: true } });
    const after = Date.now();
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(order().status).toBe(OrderStatus.DELIVERING);
    expect(db.state.history).toEqual([expect.objectContaining({ shipmentId: 's1', providerStatus: 'POL', mappedStatus: ShipmentStatus.IN_TRANSIT })]);
    // changedAt is OUR receipt time - Paxel's log time has no documented zone.
    const changedAt = new Date(db.state.history[0].changedAt).getTime();
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(after);
    expect(db.state.orderEvents).toEqual([expect.objectContaining({ orderId: 'o1', status: OrderStatus.DELIVERING, note: 'Shipment IN_TRANSIT (paxel)' })]);
    expect(db.state.outbox).toHaveLength(1);
    expect(db.state.outbox[0]).toMatchObject({ template: 'shipment.status', payload: { shipmentStatus: ShipmentStatus.IN_TRANSIT, trackingNumber: AWB, orderNumber: ORDER_NUMBER, shippingProvider: 'paxel' } });
    expect(db.state.locks).toEqual(['s1']); // processed under the shipment row lock
    expect(cache.del).toHaveBeenCalledWith(`shipment:tracking:paxel:${AWB}`);
    expect(record()).toMatchObject({ lastAppliedStatus: 'POL', lastAppliedEventAt: '2026-09-13 10:00:00', latest: { latestStatus: 'POL' } });
  }, HTTP_TEST_TIMEOUT_MS);

  it('PDO (the full example shape) → DELIVERED, order DELIVERED; internals stored in metadata only; nothing fetched', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    expect(await post(delivered())).toEqual({ status: 200, body: { received: true } });
    expect(fetchSpy.mock.calls.filter(([url]) => !String(url).startsWith('http://127.0.0.1'))).toEqual([]); // media are links, never downloaded
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(order().status).toBe(OrderStatus.DELIVERED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.DELIVERED]);
    expect(record().latest).toEqual({
      latestStatus: 'PDO',
      invoiceNumber: ORDER_NUMBER,
      deliveryDatetime: '2026-09-13 14:00:00',
      driverName: 'Heri',
      receiverName: 'Richardo Moren Silaholo',
      senderName: 'Jhon Doe',
      actualPrice: { raw: '50000', value: 50000 },
      actualWeight: { raw: '1000', value: 1000 },
      media: {
        photoUrl: MEDIA.photo, signatureUrl: MEDIA.signature, pdoPhotoUrl: MEDIA.pdo_photo, pdoSignatureUrl: MEDIA.pdo_signature,
      },
      money: { collectMoney: { raw: '10000.123', value: 10000.123 }, billNote: 'Uang yang diterima asli' },
      items: [{ code: 'SKU0000000001', name: 'Samsung J9', category: 'Handphone', specialInsurance: false }],
    });
    expect(record().logs).toEqual([expect.objectContaining({ status: 'PDO', createdDatetime: '2026-09-13 15:00:00', address: 'Muara karang Blok 7' })]);
    expect(shipment().metadata.paxel.pickupDatetime).toBe('2026-09-13T10:00:00.000Z'); // other metadata kept
    // Customer-visible providerPayload gets identifiers only, never the pushed body.
    expect(shipment().providerPayload).toEqual({ source: 'paxel.webhook', airwaybillCode: AWB, latestStatus: 'PDO', paxelEventAt: '2026-09-13 15:00:00', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(shipment().cost).toBe(18000); // actual_price never replaces what the customer was charged
    const stored = JSON.stringify(shipment().metadata);
    expect(stored).not.toContain(sign(delivered())); // the request signature is never stored
  }, HTTP_TEST_TIMEOUT_MS);

  it('CCS → CANCELLED, order CANCELLED (a legal SHIPPED → CANCELLED advance), notified once', async () => {
    expect((await post(push('CCS', '2026-09-13 11:00:00', { cancellation_reason: 'dibatalkan oleh penjual' }))).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.CANCELLED);
    expect(order().status).toBe(OrderStatus.CANCELLED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.CANCELLED]);
    expect(record().latest.cancellationReason).toBe('dibatalkan oleh penjual');
  }, HTTP_TEST_TIMEOUT_MS);

  it.each(['PRJL', 'RAP', 'UNDLM', 'RTN'])('%s → FAILED (terminal); the order is left as it was', async (code) => {
    expect((await post(push(code))).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.FAILED);
    expect(order().status).toBe(OrderStatus.SHIPPED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.FAILED]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('terminal is terminal: after PDO, a later CCS / RTN / POL changes nothing and notifies nobody', async () => {
    await post(delivered());
    for (const code of ['CCS', 'RTN', 'POL']) expect((await post(push(code, '2026-09-13 16:00:00'))).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(order().status).toBe(OrderStatus.DELIVERED);
    expect(db.state.history).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(1);
    expect(record().observations.map((o) => o.latestStatus)).toEqual(['PDO', 'CCS', 'RTN', 'POL']); // all kept
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.processed', transition: 'terminal', paxelStatus: 'CCS' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('an identical push retried → 200 each time, side effects exactly once, metadata unchanged', async () => {
    await post(delivered());
    const afterFirst = JSON.stringify(shipment());
    cache.del.mockClear();
    for (let i = 0; i < 5; i++) expect(await post(delivered())).toEqual({ status: 200, body: { received: true } });
    expect(JSON.stringify(shipment())).toBe(afterFirst);
    expect([db.state.history.length, db.state.orderEvents.length, db.state.outbox.length]).toEqual([1, 1, 1]);
    expect(cache.del).not.toHaveBeenCalled();
    expect(loggerLines.filter((l: any) => l?.event === 'paxel.webhook.duplicate')).toHaveLength(5);
  }, HTTP_TEST_TIMEOUT_MS);

  it('the same internal status twice (POD, then COD) → one transition, one notification', async () => {
    await post(push('POD', '2026-09-13 12:00:00'));
    await post(push('COD', '2026-09-13 12:30:00'));
    expect(shipment().status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.OUT_FOR_DELIVERY]);
    expect(record().observations.map((o) => o.latestStatus)).toEqual(['POD', 'COD']);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.processed', transition: 'unchanged', paxelStatus: 'COD' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('stale: a late PAPV after POL never moves the shipment backwards; the observation is kept', async () => {
    await post(push('POL', '2026-09-13 10:00:00'));
    expect((await post(push('PAPV', '2026-09-13 09:00:00'))).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(db.state.outbox).toHaveLength(1);
    expect(record().latest.latestStatus).toBe('POL'); // an older push never overwrites newer figures
    expect(record().logs.map((l) => l.status)).toEqual(['PAPV', 'POL']);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.processed', transition: 'stale', paxelStatus: 'PAPV' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('stale failure: a failed-pickup RAP dated BEFORE the pickup that moved the shipment does not fail it', async () => {
    await post(push('PAPV', '2026-09-13 10:00:00'));
    await post(push('RAP', '2026-09-13 09:30:00'));
    expect(shipment().status).toBe(ShipmentStatus.PICKED_UP);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.PICKED_UP]);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.processed', transition: 'stale', paxelStatus: 'RAP' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it.each(['FAILED3PL', 'ONHOLD3PL'])('unconfirmed %s stays AS-IS → 200, recorded, NO transition/notification, operator warning', async (code) => {
    expect(await post(push(code))).toEqual({ status: 200, body: { received: true } });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect(order().status).toBe(OrderStatus.SHIPPED);
    expect([db.state.history.length, db.state.outbox.length]).toEqual([0, 0]);
    expect(record().observations).toEqual([expect.objectContaining({ latestStatus: code, mappedStatus: null })]);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.unmapped_status', transition: 'unmapped_status', paxelStatus: code }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('after an unconfirmed code the lifecycle continues normally', async () => {
    await post(push('FAILED3PL', '2026-09-13 11:00:00'));
    expect((await post(delivered())).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
  }, HTTP_TEST_TIMEOUT_MS);

  it.each([
    // Paxel documentation (Webhook > Shipment Status Mapping), from a CREATED shipment.
    ['COL', ShipmentStatus.WAITING_PICKUP, OrderStatus.SHIPPED, false], // Courier has arrived at pickup location
    ['PAPV', ShipmentStatus.PICKED_UP, OrderStatus.DELIVERING, true], // Courier has picked up your shipment
    ['POLXL', ShipmentStatus.IN_TRANSIT, OrderStatus.DELIVERING, true], // Package on Origin Locker
    ['ODLXL', ShipmentStatus.IN_TRANSIT, OrderStatus.DELIVERING, true], // Package on Destination Locker
    ['HAPH', ShipmentStatus.IN_TRANSIT, OrderStatus.DELIVERING, true], // Hold at Paxel Home
    ['COD', ShipmentStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERING, true], // Courier has arrived at destination
    ['ODL', ShipmentStatus.OUT_FOR_DELIVERY, OrderStatus.DELIVERING, true], // On Delivery
    ['PDO', ShipmentStatus.DELIVERED, OrderStatus.DELIVERED, true], // Delivery is Completed
    ['PRJL', ShipmentStatus.FAILED, OrderStatus.SHIPPED, true], // Pickup cancelled by courier
  ] as const)('documented %s → shipment %s, order %s; one transition; a replay changes nothing', async (code, shipmentStatus, orderStatus, notifies) => {
    const body = push(code, '2026-09-13 11:00:00');
    expect(await post(body)).toEqual({ status: 200, body: { received: true } });
    expect(shipment().status).toBe(shipmentStatus);
    expect(order().status).toBe(orderStatus);
    expect(db.state.history).toHaveLength(1);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual(notifies ? [shipmentStatus] : []);
    // Duplicate delivery (Paxel retries): 200, no second history row or notification.
    expect(await post(body)).toEqual({ status: 200, body: { received: true } });
    expect(db.state.history).toHaveLength(1);
    expect(db.state.outbox).toHaveLength(notifies ? 1 : 0);
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.duplicate', paxelStatus: code }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('documented RTP ("Shipment successfully created") on a CREATED shipment → 200, already there: no transition', async () => {
    expect(await post(push('RTP'))).toEqual({ status: 200, body: { received: true } });
    expect(shipment().status).toBe(ShipmentStatus.CREATED);
    expect([db.state.history.length, db.state.outbox.length]).toEqual([0, 0]);
    expect(record().observations).toEqual([expect.objectContaining({ latestStatus: 'RTP', mappedStatus: ShipmentStatus.CREATED })]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('ODL ("On Delivery") after pickup moves to OUT_FOR_DELIVERY, and only PDO then delivers', async () => {
    await post(push('PAPV', '2026-09-13 09:00:00'));
    await post(push('ODL', '2026-09-13 11:00:00'));
    expect(shipment().status).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(order().status).toBe(OrderStatus.DELIVERING);
    await post(delivered());
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.PICKED_UP, ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('missing X-Paxel-Signature → 401; nothing looked up, locked or written', async () => {
    expect(await post(delivered(), { signature: null })).toEqual({ status: 401, body: { received: false, reason: 'X-Paxel-Signature header is required' } });
    untouched();
    expect([db.state.lookups, db.state.locks.length]).toEqual([0, 0]);
  }, HTTP_TEST_TIMEOUT_MS);

  it.each([
    ['signed with another secret', (b: Row) => sign(b, 'not-the-secret')],
    ['signed for another status (POL) than the body claims (PDO)', (b: Row) => sign({ ...b, latest_status: 'POL' })],
    ['signed for another AWB', (b: Row) => sign({ ...b, airwaybill_code: 'MERCHANT-20260913-1-ZZZZZZ' })],
    ['not a hex digest', () => 'not-a-signature'],
    ['a truncated digest', (b: Row) => sign(b).slice(0, 40)],
  ])('invalid X-Paxel-Signature (%s) → 401; nothing looked up or written', async (_label, signer) => {
    const body = delivered();
    expect(await post(body, { signature: signer(body) })).toEqual({ status: 401, body: { received: false, reason: 'invalid X-Paxel-Signature' } });
    untouched();
    expect(db.state.lookups).toBe(0);
  }, HTTP_TEST_TIMEOUT_MS);

  it('only application/json is consumed (415)', async () => {
    const res = await post('airwaybill_code=X&latest_status=PDO', { contentType: 'application/x-www-form-urlencoded', signature: 'f'.repeat(64) });
    expect(res).toEqual({ status: 415, body: { received: false, reason: 'Content-Type must be application/json' } });
    untouched();
  }, HTTP_TEST_TIMEOUT_MS);

  it('malformed JSON → 400 from the framework body parser; the service never runs', async () => {
    const res = await post('{"airwaybill_code": "X", "latest_status": ', { signature: 'f'.repeat(64) });
    expect(res.status).toBe(400);
    untouched();
    expect(db.state.lookups).toBe(0);
  }, HTTP_TEST_TIMEOUT_MS);

  it.each([
    [{ latest_status: 'PDO' }, 'airwaybill_code is required'],
    [{ airwaybill_code: AWB }, 'latest_status is required'],
    [{ airwaybill_code: 12345, latest_status: 'PDO' }, 'airwaybill_code must be a string'],
  ])('a signed request without the signed fields → 400 (%j)', async (body, reason) => {
    expect(await post(body, { signature: 'f'.repeat(64) })).toEqual({ status: 400, body: { received: false, reason } });
    untouched();
  }, HTTP_TEST_TIMEOUT_MS);

  it('unknown AWB → 404, nothing created or modified', async () => {
    expect(await post(push('PDO', undefined, { airwaybill_code: 'MERCHANT-NOPE-999999' }))).toEqual({
      status: 404, body: { received: false, reason: 'unknown airwaybill_code: no Paxel shipment has this airwaybill_code' },
    });
    expect(db.state.shipments.size).toBe(2);
    untouched();
  }, HTTP_TEST_TIMEOUT_MS);

  it('wrong provider: the AWB of a JNE shipment → 404; the JNE shipment is never touched', async () => {
    expect((await post(push('PDO', undefined, { airwaybill_code: 'JNE0001', invoice_number: 'BMS-OTHER' }))).status).toBe(404);
    expect(db.state.shipments.get('s2')).toMatchObject({ status: ShipmentStatus.CREATED, metadata: null });
    expect(db.state.orders.get('o2')!.status).toBe(OrderStatus.SHIPPED);
    expect(db.state.history).toHaveLength(0);
  }, HTTP_TEST_TIMEOUT_MS);

  it('invoice_number, when present, must be our order number (409, nothing written); when absent it is not required', async () => {
    expect(await post(push('PDO', undefined, { invoice_number: 'BMS-SOMEONE-ELSE' }))).toEqual({
      status: 409, body: { received: false, reason: 'invoice_number does not match the shipment for this airwaybill_code' },
    });
    untouched();
    const { invoice_number: _omitted, ...withoutInvoice } = push('POL');
    expect((await post(withoutInvoice)).body).toEqual({ received: true });
    expect(shipment().status).toBe(ShipmentStatus.IN_TRANSIT);
  }, HTTP_TEST_TIMEOUT_MS);

  it('a failure mid-transition rolls everything back (500); the retry then applies exactly once', async () => {
    db.state.failOutbox = true;
    expect(await post(delivered())).toEqual({ status: 500, body: { received: false, reason: 'internal error' } });
    untouched();
    db.state.failOutbox = false;
    expect(await post(delivered())).toEqual({ status: 200, body: { received: true } });
    expect(shipment().status).toBe(ShipmentStatus.DELIVERED);
    expect([db.state.history.length, db.state.orderEvents.length, db.state.outbox.length]).toEqual([1, 1, 1]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('a lifecycle with every push retried sequentially AND concurrently notifies exactly once per transition', async () => {
    const sequence = [push('PAPV', '2026-09-13 09:00:00'), push('POL', '2026-09-13 10:00:00'), push('POD', '2026-09-13 12:00:00'), delivered()];
    for (const body of sequence) {
      await Promise.all([post(body), post(body), post(body)]);
      await post(body);
    }
    expect(db.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([
      ShipmentStatus.PICKED_UP, ShipmentStatus.IN_TRANSIT, ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED,
    ]);
    expect(db.state.history).toHaveLength(4);
    expect(db.state.orderEvents.map((e) => e.status)).toEqual([OrderStatus.DELIVERING, OrderStatus.DELIVERED]);
  }, HTTP_TEST_TIMEOUT_MS);

  it('undocumented extra fields pass the strict global ValidationPipe and are not stored', async () => {
    expect(await post(push('POL', undefined, { future_field: 'keep-me-not', nested: { a: 1 } }))).toEqual({ status: 200, body: { received: true } });
    expect(JSON.stringify(shipment())).not.toContain('keep-me-not');
  }, HTTP_TEST_TIMEOUT_MS);

  it('logs carry correlators and outcomes - never the signature, the secret, or customer/courier PII', async () => {
    const body = delivered();
    await post(body);
    await post(body, { signature: sign(body, 'not-the-secret') });
    await post(push('PDO', undefined, { latest_status: 'X'.repeat(70) }));
    const logged = JSON.stringify([loggerLines, logWrites.mock.calls]);
    for (const secretish of [sign(body), sign(body, 'not-the-secret'), SECRET]) expect(logged).not.toContain(secretish);
    for (const pii of ['Richardo', 'Heri', 'Jhon Doe', 'Muara karang', 'media.paxel.example', 'Uang yang diterima', '0812000']) {
      expect(logged).not.toContain(pii);
    }
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.received', awb: AWB, paxelStatus: 'PDO' }));
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.processed', outcome: 'transitioned', transition: 'applied', from: 'CREATED', to: 'DELIVERED' }));
    expect(loggerLines).toContainEqual(expect.objectContaining({ event: 'paxel.webhook.signature_invalid', awb: AWB, reason: 'signature mismatch' }));
  }, HTTP_TEST_TIMEOUT_MS);

  it('has its own per-IP rate limit (600/min, like the JNE webhook) instead of the global 120/min', () => {
    const handler = PaxelWebhookController.prototype.paxel;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(600);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});

describe('Paxel webhook disabled (the default) or unconfigured', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  async function start(config: { enabled: boolean; secret?: string }) {
    const db = fakeDb();
    db.seed();
    const moduleRef = await Test.createTestingModule({
      controllers: [PaxelWebhookController],
      providers: [
        { provide: PrismaService, useValue: db.client },
        { provide: ShipmentProviderFactory, useValue: {} },
        ShipmentStatusMapper,
        ShipmentSyncService,
        PaxelWebhookService,
        { provide: PAXEL_WEBHOOK_CONFIG, useValue: config },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const body = delivered();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/paxel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paxel-Signature': sign(body) }, body: JSON.stringify(body),
    });
    return { db, status: res.status, body: await res.json() };
  }

  it('flag OFF: 503 even for a correctly signed push, and nothing is looked up or touched', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { db, status, body } = await start({ enabled: false, secret: SECRET });
    expect([status, body]).toEqual([503, { received: false, reason: 'Paxel webhook is not enabled' }]);
    expect(db.state.shipments.get('s1')!.status).toBe(ShipmentStatus.CREATED);
    expect([db.state.lookups, db.state.locks.length]).toEqual([0, 0]);
    jest.restoreAllMocks();
  }, HTTP_TEST_TIMEOUT_MS);

  it('enabled without a secret: fails closed (503), nothing processed', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { db, status, body } = await start({ enabled: true });
    expect([status, body]).toEqual([503, { received: false, reason: 'Paxel webhook is not configured' }]);
    expect(db.state.lookups).toBe(0);
    jest.restoreAllMocks();
  }, HTTP_TEST_TIMEOUT_MS);
});

describe('sensitive header redaction (the real pino-http request logger)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  it('X-Paxel-Signature never reaches a request log line; it is censored like Authorization', async () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });
    const db = fakeDb();
    db.seed();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [{ level: 'info', redact: PINO_HTTP_REDACT }, sink] })],
      controllers: [PaxelWebhookController],
      providers: [
        { provide: PrismaService, useValue: db.client },
        { provide: ShipmentProviderFactory, useValue: {} },
        ShipmentStatusMapper,
        ShipmentSyncService,
        PaxelWebhookService,
        { provide: PAXEL_WEBHOOK_CONFIG, useValue: { enabled: true, secret: SECRET } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const body = delivered();
    const signature = sign(body);
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/paxel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paxel-Signature': signature, Authorization: 'Bearer should-not-log' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const requestLog = lines.map((l) => JSON.parse(l)).find((l) => l.req?.url?.includes('/shipments/webhook/paxel'));
    expect(requestLog).toBeDefined();
    expect(requestLog.req.headers['x-paxel-signature']).toBe('[Redacted]');
    expect(requestLog.req.headers.authorization).toBe('[Redacted]');
    expect(lines.join('\n')).not.toContain(signature);
    expect(lines.join('\n')).not.toContain('should-not-log');
  }, HTTP_TEST_TIMEOUT_MS);
});

describe('ShipmentModule wiring (the real module, as main.ts boots it)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close(), HTTP_TEST_TIMEOUT_MS);

  it('resolves PaxelWebhookService from the module and serves POST /api/v1/shipments/webhook/paxel', async () => {
    const db = fakeDb();
    db.seed();
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
      .overrideProvider(PAXEL_WEBHOOK_CONFIG)
      .useValue({ enabled: true, secret: SECRET })
      .compile();
    expect(moduleRef.get(PaxelWebhookService)).toBeInstanceOf(PaxelWebhookService);
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const body = push('POL');
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/shipments/webhook/paxel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Paxel-Signature': sign(body) }, body: JSON.stringify(body),
    });
    expect([res.status, await res.json()]).toEqual([200, { received: true }]);
    expect(db.state.shipments.get('s1')!.status).toBe(ShipmentStatus.IN_TRANSIT);
  }, HTTP_TEST_TIMEOUT_MS);
});
