import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import { JNE_TRACKING_PROVIDER, loadShipmentTrackingConfig, ShipmentTrackingConfig } from '../../src/modules/shipment/shipment-tracking.config';
import { ShipmentTrackingWorker } from '../../src/modules/shipment/shipment-tracking.worker';

/**
 * JNE webhook-only mode: the shipment tracking poller never asks JNE unless
 * JNE_TRACKING_POLL_ENABLED=true. JNE status comes from the JNE webhook. Other couriers
 * (Paxel) keep being polled by the same worker under SHIPMENT_TRACKING_ENABLED. The JNE
 * tracking provider, parser, mapper and the webhook are unchanged.
 */

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Row = { id: string; provider: string; status: ShipmentStatus; trackingNumber: string | null; order: Record<string, unknown> };
type Where = {
  status?: { in?: ShipmentStatus[] };
  trackingNumber?: { not?: null };
  NOT?: { provider?: { equals?: string; mode?: string } };
};

const row = (id: string, provider: string, status: ShipmentStatus = ShipmentStatus.IN_TRANSIT): Row => ({
  id,
  provider,
  status,
  trackingNumber: `AWB-${id}`,
  order: {
    id: `o-${id}`,
    orderNumber: `BMS-${id}`,
    status: OrderStatus.DELIVERING,
    shippingService: 'REG',
    shippingServiceName: 'REG',
    user: { name: 'Test', email: 't@test.invalid', phone: '628100000000' },
    address: { phone: '628100000000' },
  },
});

/** Evaluates exactly the operators syncAll uses, so an excluded row is really never returned. */
function matches(r: Row, where: Where): boolean {
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.trackingNumber && 'not' in where.trackingNumber && r.trackingNumber === null) return false;
  const excluded = where.NOT?.provider;
  if (excluded?.equals !== undefined) {
    const same = excluded.mode === 'insensitive' ? r.provider.toLowerCase() === excluded.equals.toLowerCase() : r.provider === excluded.equals;
    if (same) return false;
  }
  return true;
}

function build(rows: Row[], config?: ShipmentTrackingConfig) {
  const asked: string[] = [];
  const courier = (name: string) => ({
    name,
    trackShipmentRaw: jest.fn(async (awb: string) => {
      asked.push(`${name}:${awb}`);
      return { providerStatus: 'IN_TRANSIT', rawPayload: { awb } };
    }),
  });
  const jne = courier('jne');
  const paxel = courier('paxel');
  const findMany = jest.fn(async ({ where, take }: { where: Where; take: number }) => rows.filter((r) => matches(r, where)).slice(0, take));
  const prisma = { shipment: { findMany }, $transaction: jest.fn() };
  const factory = { get: (name: string) => (name.toLowerCase() === 'jne' ? jne : name === 'paxel' ? paxel : undefined), getAll: () => [jne, paxel] };
  // Same state as the courier reports: no transition, so only the polling itself is observed.
  const mapper = { map: jest.fn(() => ({ mapped: ShipmentStatus.IN_TRANSIT, known: true })) };
  const service = new ShipmentSyncService(prisma as never, factory as never, mapper as never, undefined, config);
  return { service, jne, paxel, asked, findMany };
}

const MIXED = () => [row('j1', 'jne'), row('j2', 'JNE', ShipmentStatus.WAITING_PICKUP), row('p1', 'paxel'), row('p2', 'paxel', ShipmentStatus.PICKED_UP)];

describe('configuration', () => {
  it('JNE polling is OFF unless JNE_TRACKING_POLL_ENABLED is exactly "true"', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      expect([value, loadShipmentTrackingConfig({ JNE_TRACKING_POLL_ENABLED: value }).jnePollingEnabled]).toEqual([value, false]);
    }
    expect(loadShipmentTrackingConfig({ JNE_TRACKING_POLL_ENABLED: 'true' }).jnePollingEnabled).toBe(true);
  });

  it('staging shape (tracking worker on, JNE flag unset): the worker runs, JNE polling is disabled', () => {
    const staging = loadShipmentTrackingConfig({ SHIPMENT_TRACKING_ENABLED: 'true' });
    expect(staging).toMatchObject({ enabled: true, jnePollingEnabled: false, pollIntervalMs: 300_000, cacheTtlMs: 7_200_000 });
  });

  it('the production env template documents it as disabled', () => {
    expect(read('../production.env.example')).toMatch(/^JNE_TRACKING_POLL_ENABLED=false$/m);
    expect(read('.env.example')).toMatch(/^JNE_TRACKING_POLL_ENABLED=false$/m);
  });
});

describe('ShipmentSyncService.syncAll in JNE webhook-only mode', () => {
  it('never selects nor asks JNE (any casing); Paxel is still polled', async () => {
    const { service, jne, paxel, asked, findMany } = build(MIXED(), loadShipmentTrackingConfig({ SHIPMENT_TRACKING_ENABLED: 'true' }));
    await service.syncAll(50);
    expect(jne.trackShipmentRaw).not.toHaveBeenCalled();
    expect(paxel.trackShipmentRaw).toHaveBeenCalledTimes(2);
    expect(asked).toEqual(['paxel:AWB-p1', 'paxel:AWB-p2']);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ NOT: { provider: { equals: JNE_TRACKING_PROVIDER, mode: 'insensitive' } } });
  });

  it('JNE is excluded in the query itself, so Paxel keeps the full batch', async () => {
    const rows = [row('j1', 'jne'), row('j2', 'jne'), row('p1', 'paxel')];
    const { service, asked } = build(rows, loadShipmentTrackingConfig({}));
    await service.syncAll(1); // one slot: it must go to Paxel, not be eaten by a skipped JNE row
    expect(asked).toEqual(['paxel:AWB-p1']);
  });

  it('JNE_TRACKING_POLL_ENABLED=true restores JNE polling (the provider is intact)', async () => {
    const { service, jne, findMany } = build(MIXED(), loadShipmentTrackingConfig({ JNE_TRACKING_POLL_ENABLED: 'true' }));
    await service.syncAll(50);
    expect(jne.trackShipmentRaw).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('NOT');
  });
});

describe('ShipmentTrackingWorker (the only tracking scheduler)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('with JNE polling disabled, a real tick polls Paxel and never JNE; one single-flight timer', async () => {
    const config = loadShipmentTrackingConfig({ SHIPMENT_TRACKING_ENABLED: 'true' });
    const { service, jne, paxel } = build(MIXED(), config);
    const syncAll = jest.spyOn(service, 'syncAll');
    const worker = new ShipmentTrackingWorker(service, config);
    const logSpy = jest.spyOn((worker as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);

    worker.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('JNE polling disabled'));

    await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
    expect(syncAll).toHaveBeenCalledWith(config.batchSize);
    expect(paxel.trackShipmentRaw).toHaveBeenCalled();
    expect(jne.trackShipmentRaw).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1); // rescheduled, never duplicated

    worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('with the tracking worker disabled nothing is scheduled at all', () => {
    const config = loadShipmentTrackingConfig({});
    const { service } = build(MIXED(), config);
    const worker = new ShipmentTrackingWorker(service, config);
    jest.spyOn((worker as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    worker.onApplicationBootstrap();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('wiring: one scheduler, webhook untouched', () => {
  const MODULE = read('src/modules/shipment/shipment.module.ts');

  it('the module supplies the tracking config from the env loader (so the JNE flag always applies)', () => {
    expect(MODULE).toMatch(/\{ provide: SHIPMENT_TRACKING_CONFIG, useFactory: \(\) => loadShipmentTrackingConfig\(\) \}/);
    expect(MODULE.match(/ShipmentTrackingWorker,/g)).toHaveLength(1);
  });

  it('the JNE webhook controller and service stay registered', () => {
    expect(MODULE).toMatch(/JneWebhookController/);
    expect(MODULE).toMatch(/JneWebhookService/);
  });

  it('syncAll has exactly one caller in the application (the tracking worker) and no other scheduler exists', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk('src');
    const using = (pattern: RegExp) => files.filter((f) => pattern.test(read(f))).sort();
    expect(using(/syncAll\(/)).toEqual(['src/modules/shipment/shipment-sync.service.ts', 'src/modules/shipment/shipment-tracking.worker.ts']);
    expect(using(/trackShipmentRaw\(/).filter((f) => !f.includes('/providers/') && !f.endsWith('shipment-provider.interface.ts'))).toEqual([
      'src/modules/shipment/shipment-sync.service.ts',
    ]);
    // No cron / interval / repeatable-queue scheduler anywhere in the application.
    expect(using(/@Cron\(|@Interval\(|ScheduleModule|upsertJobScheduler|repeat:\s*\{/)).toEqual([]);
  });
});
