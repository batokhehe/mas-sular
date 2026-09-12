import { AdminService } from '../../src/modules/admin/admin.service';
import { mergeAdminShipmentMetadata } from '../../src/modules/shipment/shipment-metadata';

/**
 * An admin shipment edit used to REPLACE Shipment.metadata wholesale, which would
 * delete the JNE webhook record (and every other namespace) whenever an operator
 * saved an unrelated metadata change. It now merges, under the shipment row lock,
 * and system-owned paths keep their stored value.
 */

const WEBHOOK = {
  version: 2,
  lastReceivedAt: '2026-09-12T05:00:00.000Z',
  lastEventAt: '2026-09-12 09:00:00',
  lastAppliedEventAt: '2026-09-12 09:00:00',
  lastAppliedStatus: 'SUCCESS PICKUP',
  actual: { weight: 1.2, weightRaw: '1.2', ongkir: 21000, ongkirRaw: '21000', service: 'REG' },
  route: { originCode: 'BDO10000', destCode: 'CGK10000', senderName: 's', senderAddress: 'a', goodsDesc: 'g' },
  summaries: [{ status: 'SUCCESS PICKUP', eventAt: '2026-09-12 09:00:00', firstReceivedAt: '2026-09-12T05:00:00.000Z' }],
  events: [{ key: 'k1', date: '2026-09-12 09:00:00', status: 'PICKED UP', statusCode: 'PU1', statusDesc: 'PICKED UP BY COURIER', locationCode: 'BDO' }],
};

const STORED = {
  jne: { pickupDatetime: '2026-09-12T10:00:00.000Z', webhook: WEBHOOK },
  paxel: { pickupDatetime: '2026-09-11T08:00:00.000Z' },
  error: 'earlier booking failure',
  failedAt: '2026-09-11T07:00:00.000Z',
  tracking: { rejected: [{ source: 'poll', provider: 'jne', providerStatus: 'PICKED_UP', mappedStatus: 'PICKED_UP', shipmentStatus: 'IN_TRANSIT', reason: 'would_regress', firstSeenAt: '2026-09-12T06:00:00.000Z' }] },
  opsNote: { text: 'old note', by: 'admin-1' },
};

function build(metadata: unknown = STORED) {
  const shipment = {
    id: 'sh1', provider: 'jne', service: 'REG', cost: 18000, status: 'IN_TRANSIT',
    trackingNumber: 'AWB1', providerShipmentId: 'AWB1', trackingUrl: null, metadata,
    order: { id: 'o1', orderNumber: 'BMS-1' },
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    shipment: {
      findUnique: jest.fn().mockImplementation(() => Promise.resolve({ metadata: shipment.metadata })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...shipment, ...data })),
    },
  };
  const prisma = {
    shipment: {
      findUnique: jest.fn().mockResolvedValue(shipment),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...shipment, ...data })),
    },
    $transaction: jest.fn().mockImplementation((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  const cache = { del: jest.fn().mockResolvedValue(undefined), get: jest.fn(), set: jest.fn() };
  const service = new AdminService(prisma as never, {} as never, undefined, undefined, undefined, cache as never);
  return { service, prisma, tx };
}

const written = (tx: ReturnType<typeof build>['tx']) => tx.shipment.update.mock.calls[0][0].data.metadata as Record<string, any>;

describe('admin shipment edit: metadata is merged, never replaced', () => {
  it('1-4. an unrelated metadata edit keeps jne.webhook unchanged and every other namespace intact', async () => {
    const { service, tx } = build();
    // Precondition 1: the shipment carries a JNE webhook record.
    expect(STORED.jne.webhook).toBeDefined();

    // 2. The admin edits an unrelated key.
    await service.updateShipment('sh1', { metadata: { opsNote: { text: 'call receiver before 17:00' } } } as never);

    const metadata = written(tx);
    expect(metadata.jne.webhook).toEqual(WEBHOOK); // 3. unchanged
    // 4. Unrelated metadata intact; the edited namespace merged (its other keys kept).
    expect(metadata.jne.pickupDatetime).toBe('2026-09-12T10:00:00.000Z');
    expect(metadata.paxel).toEqual(STORED.paxel);
    expect(metadata.error).toBe('earlier booking failure');
    expect(metadata.failedAt).toBe('2026-09-11T07:00:00.000Z');
    expect(metadata.tracking).toEqual(STORED.tracking);
    expect(metadata.opsNote).toEqual({ text: 'call receiver before 17:00', by: 'admin-1' });
    // Merged under the shipment row lock, inside one transaction.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('editing a field INSIDE the jne namespace updates it and still keeps jne.webhook', async () => {
    const { service, tx } = build();
    await service.updateShipment('sh1', { metadata: { jne: { pickupDatetime: '2026-09-13T10:00:00.000Z' } } } as never);
    expect(written(tx).jne).toEqual({ pickupDatetime: '2026-09-13T10:00:00.000Z', webhook: WEBHOOK });
  });

  it('system-owned paths cannot be overwritten or deleted from the admin edit', async () => {
    const { service, tx } = build();
    await service.updateShipment('sh1', {
      metadata: { jne: { webhook: { forged: true } }, tracking: null },
    } as never);
    const metadata = written(tx);
    expect(metadata.jne.webhook).toEqual(WEBHOOK);
    expect(metadata.tracking).toEqual(STORED.tracking);
  });

  it('an admin edit on a shipment with no metadata yet simply stores the edit (system paths stay absent)', () => {
    expect(mergeAdminShipmentMetadata(null, { opsNote: 'x', jne: { webhook: { forged: true } } })).toEqual({ opsNote: 'x', jne: {} });
  });

  it('an edit WITHOUT metadata keeps the previous code path exactly (no transaction, metadata untouched)', async () => {
    const { service, prisma, tx } = build();
    await service.updateShipment('sh1', { trackingUrl: 'https://jne.example/track/AWB1' } as never);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.shipment.update).not.toHaveBeenCalled();
    const data = prisma.shipment.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('metadata');
    expect(data.trackingUrl).toBe('https://jne.example/track/AWB1');
  });
});
