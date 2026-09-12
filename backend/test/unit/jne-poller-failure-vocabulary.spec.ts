import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { JneShipmentProvider } from '../../src/modules/shipment/infrastructure/providers/jne-shipment.provider';
import { readShipmentMetadata } from '../../src/modules/shipment/shipment-metadata';
import { lookupProviderStatus, ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';
import { ShipmentSyncService } from '../../src/modules/shipment/shipment-sync.service';
import type { ShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * JNE tracking POLLER vs the JNE WEBHOOK on failures - and the documentation gap
 * between them.
 *
 * The webhook records FAILED PICKUP / SHIPMENT PROBLEM without a transition. The
 * poller can only act on what the JNE tracking adapter exposes: ONE free-text field,
 * `cnote.pod_status`. No JNE tracking status vocabulary exists in this codebase, so
 * the poller cannot tell a failed pickup from a failed shipment, and the generic
 * FAILED / RETURNED / UNDELIVERED words keep their terminal FAILED mapping. These
 * tests pin that - deliberately - so any future change to it is a conscious one made
 * with JNE's documented vocabulary in hand.
 *
 * Runs the REAL JneShipmentProvider (HTTP stubbed - no JNE call), the real poller,
 * mapper and shared transition rule.
 */

type Row = Record<string, any>;

function jneAdapter(podStatus: string) {
  const provider = new JneShipmentProvider({
    jne: { enabled: true, baseUrl: 'https://jne.invalid', apiKey: 'k', username: 'u', originCode: 'BDO10000', timeoutMs: 500, maxRetry: 0 },
  } as unknown as ShippingConfig);
  const calls: string[] = [];
  (provider as unknown as { http: unknown }).http = async (url: string) => {
    calls.push(url);
    return { status: 200, text: async () => JSON.stringify({ cnote: { pod_status: podStatus, other_field: 'ignored' } }), headers: { get: () => null } };
  };
  return { provider, calls };
}

function world(shipmentStatus: ShipmentStatus) {
  const state = {
    shipment: {
      id: 's1', orderId: 'o1', provider: 'jne', service: 'REG', status: shipmentStatus, cost: 18000,
      trackingNumber: 'AWB1', metadata: { jne: { webhook: { version: 2, keep: true } } } as Row, providerPayload: null as unknown,
    },
    order: {
      id: 'o1', orderNumber: 'BMS-1', status: OrderStatus.SHIPPED as OrderStatus, shippingService: 'REG', shippingServiceName: 'JNE REG',
      user: { name: 'Jane', email: 'jane@test.invalid', phone: '0812' }, address: { phone: '0812' },
    },
    history: [] as Row[],
    outbox: [] as Row[],
  };
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const tx: Row = {
    $queryRaw: async () => [],
    shipment: {
      findUnique: async () => ({ metadata: clone(state.shipment.metadata) }),
      update: async ({ data }: Row) => Object.assign(state.shipment, clone(data)),
      updateMany: async ({ where, data }: Row) => {
        if (where.status !== state.shipment.status) return { count: 0 };
        Object.assign(state.shipment, clone(data));
        return { count: 1 };
      },
    },
    shipmentHistory: { create: async ({ data }: Row) => state.history.push(data) },
    order: {
      updateMany: async ({ where, data }: Row) => {
        if (!where.status.in.includes(state.order.status)) return { count: 0 };
        state.order.status = data.status;
        return { count: 1 };
      },
    },
    orderEvent: { create: async () => undefined },
    notificationOutbox: { create: async ({ data }: Row) => state.outbox.push(data) },
  };
  const prisma: Row = {
    shipment: { findMany: async () => [{ ...clone(state.shipment), order: clone(state.order) }] },
    $transaction: async (cb: (t: Row) => Promise<unknown>) => cb(tx),
  };
  return { state, prisma };
}

async function poll(w: ReturnType<typeof world>, podStatus: string) {
  const { provider, calls } = jneAdapter(podStatus);
  const mapper = new ShipmentStatusMapper();
  jest.spyOn(mapper['logger'], 'warn').mockImplementation(() => undefined);
  const sync = new ShipmentSyncService(w.prisma as never, { get: () => provider, getAll: () => [provider] } as never, mapper);
  const changed = await sync.syncAll();
  return { changed, calls };
}

const rejected = (w: ReturnType<typeof world>) => readShipmentMetadata(w.state.shipment.metadata as never).tracking?.rejected ?? [];

describe('what the JNE tracking adapter gives the poller', () => {
  it('exactly one free-text field - cnote.pod_status, verbatim - and nothing that could tell failure kinds apart', async () => {
    const { provider, calls } = jneAdapter('FAILED');
    const raw = await provider.trackShipmentRaw('AWB1');
    expect(raw.providerStatus).toBe('FAILED');
    expect(calls).toEqual(['https://jne.invalid/tracing/api/list/v1/cnote']); // stubbed: never a real JNE call
  });
});

describe('DOCUMENTATION GAP: generic JNE failure words keep the terminal FAILED mapping (unchanged)', () => {
  it.each(['FAILED', 'RETURNED', 'UNDELIVERED'])(
    'pod_status %s → FAILED (terminal), customer notified once - exactly as before the webhook existed',
    async (podStatus) => {
      const w = world(ShipmentStatus.CREATED);
      expect((await poll(w, podStatus)).changed).toBe(1);
      expect(w.state.shipment.status).toBe(ShipmentStatus.FAILED);
      expect(w.state.history).toEqual([expect.objectContaining({ providerStatus: podStatus, mappedStatus: ShipmentStatus.FAILED })]);
      expect(w.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.FAILED]);
      expect(w.state.order.status).toBe(OrderStatus.SHIPPED); // FAILED never moves the order (unchanged)
    },
  );

  it('the vocabulary itself is pinned: changing it requires JNE\'s documented pod_status values', () => {
    expect(['FAILED', 'RETURNED', 'UNDELIVERED'].map((s) => lookupProviderStatus('jne', s))).toEqual([
      ShipmentStatus.FAILED, ShipmentStatus.FAILED, ShipmentStatus.FAILED,
    ]);
    // Nothing invented: no JNE tracking word is mapped to "failed pickup" or "problem".
    for (const guess of ['PICKUP FAILED', 'FAILED_PICKUP', 'GAGAL PICKUP', 'PROBLEM', 'EXCEPTION', 'ON HOLD']) {
      expect(lookupProviderStatus('jne', guess)).toBeUndefined();
    }
  });
});

describe('IF pod_status ever carries the webhook\'s own summary words, the poller already behaves like the webhook', () => {
  it('FAILED PICKUP → no transition (unknown to the poller), then SUCCESS PICKUP recovers normally', async () => {
    const w = world(ShipmentStatus.CREATED);
    expect((await poll(w, 'FAILED PICKUP')).changed).toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.CREATED); // still tracked, not terminal
    expect([w.state.history.length, w.state.outbox.length]).toEqual([0, 0]);

    expect((await poll(w, 'SUCCESS PICKUP')).changed).toBe(1);
    expect(w.state.shipment.status).toBe(ShipmentStatus.PICKED_UP);
    expect(w.state.outbox.map((o) => o.payload.shipmentStatus)).toEqual([ShipmentStatus.PICKED_UP]);
  });

  it('SHIPMENT PROBLEM → no transition', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    expect((await poll(w, 'SHIPMENT PROBLEM')).changed).toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(w.state.outbox).toHaveLength(0);
  });

  it('RETURN TO SHIPPER → FAILED (the existing behaviour, same as the webhook)', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    expect((await poll(w, 'RETURN TO SHIPPER')).changed).toBe(1);
    expect(w.state.shipment.status).toBe(ShipmentStatus.FAILED);
  });
});

describe('stale JNE polling answers cannot regress a shipment', () => {
  it('IN_TRANSIT + a stale SUCCESS PICKUP → rejected and recorded, not applied', async () => {
    const w = world(ShipmentStatus.IN_TRANSIT);
    expect((await poll(w, 'SUCCESS PICKUP')).changed).toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(rejected(w)).toEqual([expect.objectContaining({ providerStatus: 'SUCCESS PICKUP', reason: 'would_regress' })]);
    expect(w.state.shipment.metadata.jne.webhook).toEqual({ version: 2, keep: true }); // webhook record untouched
  });

  it('a DELIVERED shipment is never failed by a later generic FAILED answer', async () => {
    const w = world(ShipmentStatus.DELIVERED);
    expect((await poll(w, 'FAILED')).changed).toBe(0);
    expect(w.state.shipment.status).toBe(ShipmentStatus.DELIVERED);
    expect(rejected(w)).toEqual([expect.objectContaining({ providerStatus: 'FAILED', reason: 'terminal' })]);
  });
});

describe('Paxel status mappings are unchanged', () => {
  it.each([
    ['RAP', ShipmentStatus.FAILED], ['RTN', ShipmentStatus.FAILED], ['UNDLM', ShipmentStatus.FAILED], ['PRJL', ShipmentStatus.FAILED],
    ['CCS', ShipmentStatus.CANCELLED], ['PDO', ShipmentStatus.DELIVERED], ['POD', ShipmentStatus.OUT_FOR_DELIVERY], ['PAPV', ShipmentStatus.PICKED_UP],
  ])('paxel %s → %s', (code, status) => {
    expect(lookupProviderStatus('paxel', code)).toBe(status);
  });

  it('the JNE-only words do not leak into Paxel', () => {
    for (const word of ['SUCCESS PICKUP', 'SHIPPED', 'RETURN TO SHIPPER', 'FAILED PICKUP', 'SHIPMENT PROBLEM', 'RETURNED', 'UNDELIVERED']) {
      expect(lookupProviderStatus('paxel', word)).toBeUndefined();
    }
  });
});
