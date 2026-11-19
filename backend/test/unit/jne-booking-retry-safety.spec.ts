import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentService, RECONCILIATION_REQUIRED } from '../../src/modules/shipment/shipment.service';
import { PaxelPickupScheduler } from '../../src/modules/shipment/paxel-pickup-scheduler';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';
import { AmbiguousBookingError, PermanentError } from '../../src/modules/shipping/domain/shipping-errors';
import {
  buildJnePickupCashlessFields,
  JNE_ADDRESS_MAX_LENGTH,
  serializeJnePickupCashless,
  stripJneControlCharacters,
  toJneAddressLine,
} from '../../src/modules/shipment/infrastructure/providers/jne-pickup-cashless';
import { computeAvailableActions } from '../../src/modules/admin/order-operations.util';

/**
 * Incident BMS-20261118-CKK0SJS2 (+ 8VQ57K4N, PQ52H2K3): JNE /pickupcashless refused
 * every booking whose RECEIVER_ADDR1 carried a line break from the multi-line
 * address-detail field (HTTP 413 "Message size not conform our policy"). Six
 * retries all failed identically. The 30-character truncation alone does not help
 * when the break sits inside the first 30 characters (position 19 for CKK0SJS2).
 *
 * Also: an AMBIGUOUS courier answer must never become a blind second booking.
 */

// ---------------------------------------------------------------- request -----

describe('JNE address lines never carry line breaks', () => {
  // Same shape as the incident: a break at character 19, then more text.
  const INCIDENT_SHAPE = 'Jl. Melati Gg. 3 N\r\nRT 004 RW 005 rumah pagar hijau dekat warung';

  it('the incident shape becomes one clean line of at most 30 characters', () => {
    const line = toJneAddressLine(INCIDENT_SHAPE);
    expect(line).not.toMatch(/[\r\n]/);
    expect(Array.from(line).length).toBeLessThanOrEqual(JNE_ADDRESS_MAX_LENGTH);
    expect(line).toBe('Jl. Melati Gg. 3 N RT 004 RW 0');
  });

  it('truncation alone would still have sent the line break (why the 2642db6 fix was not enough)', () => {
    const truncatedOnly = Array.from(INCIDENT_SHAPE).slice(0, JNE_ADDRESS_MAX_LENGTH).join('');
    expect(truncatedOnly).toMatch(/\r\n/);
  });

  it('collapses tabs, CR, LF, Unicode separators and repeated spaces; keeps short lines intact', () => {
    expect(toJneAddressLine('A\tB C D   E\u0085F')).toBe('A B C D E F');
    expect(toJneAddressLine('  Jl. Veteran No. 65  ')).toBe('Jl. Veteran No. 65');
    expect(stripJneControlCharacters('no breaks here')).toBe('no breaks here');
  });

  it('a long single-line address is still truncated to 30 characters', () => {
    expect(toJneAddressLine('Jalan Raya Kebayoran Lama No. 123 RT 004 RW 005')).toBe('Jalan Raya Kebayoran Lama No. ');
  });

  it('builds all four address fields clean and leaves the source address object unchanged', () => {
    const receiver = {
      name: 'Pelanggan',
      phone: '081200000000',
      addressDetail: INCIDENT_SHAPE,
      village: 'Kebon\nPisang',
      district: 'Sumur Bandung',
      city: 'Kota Bandung',
      postalCode: '40112',
      province: 'Jawa Barat',
    };
    const before = JSON.stringify(receiver);
    const fields = buildJnePickupCashlessFields(
      {
        orderNumber: 'BMS-20261118-CKK0SJS2',
        service: 'REG',
        goodsAmount: 90_000,
        destinationCode: 'BDO10060',
        pickupAtIso: '2026-11-18T10:00:00.000Z',
        receiver,
        items: [{ name: 'Bakso', quantity: 1, weightGram: 500 }],
      },
      {
        pickupName: 'Outlet', pickupPic: 'Pic', pickupPicPhone: '081200000001', pickupAddress: 'Jl. Gudang 1',
        pickupDistrict: 'Sumur Bandung', pickupCity: 'Kota Bandung', pickupService: 'Domestic', pickupVehicle: 'Motor',
        branch: 'BR', custId: 'CU', merchantId: 'ME', shipperName: 'Mas Sular',
        shipperAddr1: 'Jl. Gudang\r\nNo. 1 Blok Belakang Pasar Lama', shipperAddr2: 'Kel. Braga',
        shipperCity: 'Kota Bandung', shipperZip: '40111', shipperRegion: 'Jawa Barat', shipperContact: 'Ops',
        shipperPhone: '081200000002', type: 'PICKUP',
      },
      'BDO10000',
    );
    for (const key of ['SHIPPER_ADDR1', 'SHIPPER_ADDR2', 'RECEIVER_ADDR1', 'RECEIVER_ADDR2'] as const) {
      expect(fields[key]).not.toMatch(/[\u0000-\u001F]/);
      expect(Array.from(fields[key]).length).toBeLessThanOrEqual(JNE_ADDRESS_MAX_LENGTH);
    }
    expect(fields.RECEIVER_ADDR1).toBe('Jl. Melati Gg. 3 N RT 004 RW 0');
    expect(JSON.stringify(receiver)).toBe(before); // the stored address is never modified

    const body = serializeJnePickupCashless({ username: 'u', apiKey: 'k' }, fields);
    expect(body).not.toMatch(/%0[AD]/i);
  });
});

// ---------------------------------------------------------------- retries -----

const CONFIG = {
  paxel: { autoPickup: { enabled: false, ...DEFAULT_PICKUP_POLICY } },
  pickupPolicy: DEFAULT_PICKUP_POLICY,
} as unknown as ShippingConfig;

const OUTLET = {
  id: 'out1', name: 'Outlet', postalCode: '40286', addressDetail: 'Jl. Outlet 1', latitude: null, longitude: null,
  province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Buahbatu' }, village: { name: 'Margasari' },
};

type ShipmentRow = {
  id: string;
  orderId: string;
  provider: string;
  service: string;
  status: ShipmentStatus;
  trackingNumber: string | null;
  providerShipmentId: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: Date;
};

/**
 * A stateful single-order store: the booking-claim CAS, the failure mark and the
 * success transaction act on ONE shipment row and ONE order, so a sequence of
 * attempts behaves as it would against the database.
 */
function harness(initial: Partial<ShipmentRow> = {}) {
  const shipment: ShipmentRow = {
    id: 'sh1', orderId: 'o1', provider: 'jne', service: 'REG', status: ShipmentStatus.FAILED,
    trackingNumber: null, providerShipmentId: null,
    metadata: { jne: { pickupDatetime: '2026-11-18T10:00:00.000Z' }, error: 'provider 413: Message size not conform our policy' },
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    ...initial,
  };
  const order = { id: 'o1', status: OrderStatus.PROCESSING as OrderStatus, trackingNumber: null as string | null };
  const address = {
    recipientName: 'Pelanggan', phone: '081200000000',
    addressDetail: 'Jl. Melati Gg. 3 N\r\nRT 004 RW 005 rumah pagar hijau', fullAddress: 'unused',
    postalCode: '40112', districtId: 'd1', notes: null, latitude: null, longitude: null,
    province: { name: 'Jawa Barat' }, city: { name: 'Kota Bandung' }, district: { name: 'Sumur Bandung' }, village: { name: 'Kebon Pisang' },
  };
  const addressSnapshot = JSON.stringify(address);
  const events: Array<{ status: OrderStatus }> = [];

  const loadOrder = () => ({
    id: order.id, orderNumber: 'BMS-20261118-CKK0SJS2', subtotal: 90_000, totalPrice: 100_000,
    paymentMethod: 'BANK_TRANSFER', shippingProvider: 'jne', shippingService: 'REG', shippingServiceName: 'JNE REG',
    outletId: 'out1', status: order.status, payment: { verifiedAt: new Date('2026-11-18T06:15:49Z') },
    shipment: { ...shipment }, address, user: { name: 'Pelanggan', email: 'p@example.test', phone: null },
    items: [{ productId: 'p1', quantity: 1, productName: 'Bakso', unitPrice: 90_000, weightGram: 500, lengthCm: 10, widthCm: 10, heightCm: 10, isFragile: false, product: { sku: 'S1', name: 'Bakso', category: { name: 'Makanan' } } }],
  });

  type ClaimWhere = {
    id?: string; orderId?: string; trackingNumber?: null;
    OR?: Array<{ status: ShipmentStatus | { in: ShipmentStatus[] }; updatedAt?: { lte: Date } }>;
  };
  const matchesWhere = (w: ClaimWhere) => {
    if (w.id && w.id !== shipment.id) return false;
    if (w.orderId && w.orderId !== shipment.orderId) return false;
    if (w.trackingNumber === null && shipment.trackingNumber !== null) return false;
    if (w.OR) {
      return w.OR.some((branch) => {
        const statusOk =
          typeof branch.status === 'object' ? branch.status.in.includes(shipment.status) : branch.status === shipment.status;
        const leaseOk = branch.updatedAt ? shipment.updatedAt <= branch.updatedAt.lte : true;
        return statusOk && leaseOk;
      });
    }
    return true;
  };
  const apply = (data: Partial<ShipmentRow>) => {
    Object.assign(shipment, JSON.parse(JSON.stringify(data)), { updatedAt: new Date() });
  };

  const tx = {
    shipment: { update: jest.fn(async ({ data }: { data: Partial<ShipmentRow> }) => apply(data)) },
    order: {
      updateMany: jest.fn(async ({ where, data }: { where: { status: { in: OrderStatus[] } }; data: { status: OrderStatus; trackingNumber: string } }) => {
        if (!where.status.in.includes(order.status)) return { count: 0 };
        order.status = data.status;
        order.trackingNumber = data.trackingNumber;
        return { count: 1 };
      }),
    },
    orderEvent: { create: jest.fn(async ({ data }: { data: { status: OrderStatus } }) => events.push(data)) },
    notificationOutbox: { create: jest.fn().mockResolvedValue({}) },
    outboxEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    order: { findUnique: jest.fn(async () => loadOrder()) },
    outlet: { findUnique: jest.fn().mockResolvedValue(OUTLET), findFirst: jest.fn().mockResolvedValue(OUTLET) },
    shipment: {
      updateMany: jest.fn(async ({ where, data }: { where: ClaimWhere; data: Partial<ShipmentRow> }) => {
        if (!matchesWhere(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => ({ ...shipment })),
      update: jest.fn(async ({ data }: { data: Partial<ShipmentRow> }) => apply(data)),
    },
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  const provider = { name: 'jne', supportsAutomaticBooking: true, createShipment: jest.fn() };
  const factory = { get: jest.fn().mockReturnValue(provider) };
  const service = new ShipmentService(prisma as never, factory as never, undefined, new PaxelPickupScheduler(CONFIG));
  return { service, provider, shipment, order, events, address, addressSnapshot };
}

const BOOKED = {
  trackingNumber: 'CNOTE-0001',
  providerShipmentId: 'CNOTE-0001',
  status: ShipmentStatus.CREATED,
  rawPayload: { detail: [{ status: 'success', cnote_no: 'CNOTE-0001' }] },
};

describe('JNE booking retry safety', () => {
  it('a definitively FAILED shipment can be retried; success records the AWB and ships the order once', async () => {
    const h = harness();
    h.provider.createShipment.mockResolvedValue(BOOKED);

    const outcome = await h.service.retry('o1');

    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: 'CNOTE-0001' });
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.shipment).toMatchObject({ status: ShipmentStatus.CREATED, trackingNumber: 'CNOTE-0001', providerShipmentId: 'CNOTE-0001' });
    expect(h.order).toMatchObject({ status: OrderStatus.SHIPPED, trackingNumber: 'CNOTE-0001' });
    expect(h.events).toEqual([expect.objectContaining({ status: OrderStatus.SHIPPED })]);
  });

  it('the retry sends the stored address through the current builder input, unchanged at the source', async () => {
    const h = harness();
    h.provider.createShipment.mockResolvedValue(BOOKED);
    await h.service.retry('o1');
    const input = h.provider.createShipment.mock.calls[0][0];
    expect(input.destination.addressDetail).toBe(h.address.addressDetail); // builder normalizes, not the store
    expect(JSON.stringify(h.address)).toBe(h.addressSnapshot);
  });

  it('an existing AWB prevents any second booking (no courier call)', async () => {
    const h = harness({ status: ShipmentStatus.CREATED, trackingNumber: 'CNOTE-EXISTING' });
    const outcome = await h.service.retry('o1');
    expect(outcome).toEqual({ ok: true, status: ShipmentStatus.CREATED, trackingNumber: 'CNOTE-EXISTING' });
    expect(h.provider.createShipment).not.toHaveBeenCalled();
    expect(h.shipment.trackingNumber).toBe('CNOTE-EXISTING');
  });

  it('a definitive failure on retry keeps the shipment FAILED (retryable) and the order PROCESSING', async () => {
    const h = harness();
    h.provider.createShipment.mockRejectedValue(new PermanentError('provider 413: Message size not conform our policy', 'jne'));

    const outcome = await h.service.retry('o1');

    expect(outcome).toMatchObject({ ok: false, status: ShipmentStatus.FAILED });
    expect(h.shipment.status).toBe(ShipmentStatus.FAILED);
    expect(h.shipment.trackingNumber).toBeNull();
    expect(h.shipment.metadata).toMatchObject({ error: expect.stringContaining('413'), jne: { pickupDatetime: expect.any(String) } });
    expect(h.shipment.metadata?.reconciliationRequired).toBeUndefined();
    expect(h.order.status).toBe(OrderStatus.PROCESSING);
    expect(h.events).toEqual([]);
  });

  it('an AMBIGUOUS answer parks the shipment as UNKNOWN with reconciliationRequired, order untouched', async () => {
    const h = harness();
    h.provider.createShipment.mockRejectedValue(new AmbiguousBookingError('JNE booking outcome unknown - network error: timeout', 'jne'));

    const outcome = await h.service.retry('o1');

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(ShipmentStatus.UNKNOWN);
    expect(outcome.error).toContain(RECONCILIATION_REQUIRED);
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.metadata).toMatchObject({ reconciliationRequired: true, jne: { pickupDatetime: expect.any(String) } });
    expect(h.order.status).toBe(OrderStatus.PROCESSING);
  });

  it('after an ambiguous answer, further retries NEVER call the courier again', async () => {
    const h = harness();
    h.provider.createShipment.mockRejectedValueOnce(new AmbiguousBookingError('JNE booking outcome unknown', 'jne'));
    await h.service.retry('o1');

    h.provider.createShipment.mockResolvedValue(BOOKED);
    const second = await h.service.retry('o1');
    const third = await h.service.createForOrderSafe('o1');

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED });
    expect(third.status).toBe(ShipmentStatus.UNKNOWN);
    expect(h.shipment.status).toBe(ShipmentStatus.UNKNOWN); // never downgraded to FAILED by the refusal
  });

  it('the admin Retry action is not offered for an UNKNOWN (reconciliation) shipment', () => {
    const unknown = computeAvailableActions({
      status: OrderStatus.PROCESSING,
      payment: { status: 'PAID' as never, manualReceiptUrl: null },
      shipment: { status: ShipmentStatus.UNKNOWN, trackingNumber: null, trackingUrl: null },
    } as never);
    expect(unknown.retryShipment).toBe(false);
    const failed = computeAvailableActions({
      status: OrderStatus.PROCESSING,
      payment: { status: 'PAID' as never, manualReceiptUrl: null },
      shipment: { status: ShipmentStatus.FAILED, trackingNumber: null, trackingUrl: null },
    } as never);
    expect(failed.retryShipment).toBe(true);
  });

  it('once an operator reconciles (no booking at JNE -> FAILED), retry works again and books once', async () => {
    const h = harness({ status: ShipmentStatus.UNKNOWN, metadata: { reconciliationRequired: true, jne: { pickupDatetime: '2026-11-18T10:00:00.000Z' } } });
    h.shipment.status = ShipmentStatus.FAILED; // the operator's documented PATCH after confirming with JNE
    h.provider.createShipment.mockResolvedValue(BOOKED);

    const outcome = await h.service.retry('o1');

    expect(outcome.ok).toBe(true);
    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(h.order.status).toBe(OrderStatus.SHIPPED);
  });

  it('two concurrent retries book at most once (CAS claim)', async () => {
    const h = harness();
    let release!: () => void;
    h.provider.createShipment.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(BOOKED); }),
    );
    const first = h.service.retry('o1');
    await new Promise((r) => setImmediate(r));
    const second = await h.service.retry('o1'); // claim lost while the first is in flight
    release();
    const firstOutcome = await first;

    expect(h.provider.createShipment).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(false);
    expect(firstOutcome).toMatchObject({ ok: true, trackingNumber: 'CNOTE-0001' });
  });
});
