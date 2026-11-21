import { ArgumentMetadata, ConflictException, ValidationPipe } from '@nestjs/common';
import { Prisma, ShipmentStatus } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { UpdateShipmentDto } from '../../src/modules/admin/application/dto/admin-operations.dto';
import { BOOKING_IN_PROGRESS, RECONCILIATION_REQUIRED, ShipmentService } from '../../src/modules/shipment/shipment.service';

/**
 * Duplicate-booking recovery vs the generic admin shipment endpoints.
 *
 * `PATCH /admin/shipments/:id` and `DELETE /admin/shipments/:id` must not be a way
 * around the reconciliation workflow:
 *  - an UNKNOWN shipment (the courier may hold a booking) must not become FAILED /
 *    RATE_SELECTED / PENDING, get an AWB, or be deleted - only reconcileBooking,
 *    which demands courier evidence and matches the captured AWB, resolves it;
 *  - a PENDING shipment owned by a booking attempt must not be reset, edited or
 *    deleted - that would release the claim to a second courier booking;
 *  - recovery metadata (booking.*, reconciliationRequired) and the owner columns are
 *    never written by a generic edit;
 *  - the write is a compare-and-set on what was checked, so a claim landing between
 *    the check and the write makes the edit fail rather than reset the claim.
 * Ordinary shipments keep every edit they had.
 *
 * Bypasses found by the audit, each pinned below:
 *  B1 PATCH status UNKNOWN -> FAILED / RATE_SELECTED / PENDING (reopens booking, no evidence)
 *  B2 PATCH trackingNumber on UNKNOWN (skips captured-AWB match and the SHIPPED flip)
 *  B3 PATCH status/AWB/metadata on an owned PENDING (releases a live claim)
 *  B4 PATCH racing a claim (check passed on RATE_SELECTED, write lands on owned PENDING)
 *  B5 DELETE an UNKNOWN / owned PENDING shipment, then re-create it (reopens booking)
 *  B6 DELETE a shipment holding the captured AWB (destroys the only record of it)
 *  B7 PATCH metadata removing reconciliationRequired (was operator-editable)
 *  B8 Shipments/prepare rewriting slot/service of an UNKNOWN or owned shipment
 */

type Row = Record<string, unknown> & {
  id: string; orderId: string; provider: string; service: string; cost: number; status: ShipmentStatus;
  trackingNumber: string | null; providerShipmentId: string | null; trackingUrl: string | null;
  metadata: Record<string, unknown> | null; bookingAttemptId: string | null; bookingAttemptStartedAt: Date | null;
};

const OWNER = '6d0f5c1e-6c37-4d7e-9a43-2f5f0b8f1a11';
const CAPTURED_AWB = 'CO.EMSULAR-20261121-7-ABCDEF';
const RECOVERY_METADATA = {
  reconciliationRequired: true,
  paxel: { pickupDatetime: '2026-11-23T10:00:00.000Z' },
  booking: { unrecorded: { provider: 'paxel', trackingNumber: CAPTURED_AWB, providerShipmentId: CAPTURED_AWB, bookedAt: '2026-11-21T03:05:00.000Z', persistError: 'connection reset', attemptId: OWNER } },
};
const notFound = () => new Prisma.PrismaClientKnownRequestError('No record was found.', { code: 'P2025', clientVersion: 'test' });

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) => (v === undefined ? true : v === null ? row[k] === null : row[k] === v));
}

function build(initial: Partial<Row>) {
  const row: Row = {
    id: 'sh1', orderId: 'o1', provider: 'paxel', service: 'PAXEL_NEXTDAY', cost: 30000,
    status: ShipmentStatus.RATE_SELECTED, trackingNumber: null, providerShipmentId: null, trackingUrl: null,
    metadata: { paxel: { pickupDatetime: '2026-11-23T10:00:00.000Z' } }, bookingAttemptId: null, bookingAttemptStartedAt: null,
    ...initial,
  };
  /** Runs between the service's read and its write (a concurrent claim, say). */
  let between: (() => void) | null = null;
  const read = () => {
    const snapshot = { ...row, metadata: row.metadata ? JSON.parse(JSON.stringify(row.metadata)) : null, order: { id: row.orderId } };
    if (between) { between(); between = null; }
    return snapshot;
  };
  const update = jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    if (!matches(row, where)) throw notFound();
    for (const [k, v] of Object.entries(data)) if (v !== undefined) (row as Record<string, unknown>)[k] = v;
    return { ...row };
  });
  const remove = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if (!matches(row, where)) throw notFound();
    row.status = 'DELETED' as ShipmentStatus;
    return { ...row };
  });
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    shipment: { findUnique: jest.fn(async () => ({ metadata: row.metadata })), update },
  };
  const prisma = {
    shipment: { findUnique: jest.fn(async () => read()), update, delete: remove },
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  const service = new AdminService(prisma as never, {} as never);
  return { service, prisma, row, update, remove, setBetween: (fn: () => void) => { between = fn; } };
}

const unknownShipment = () => build({ status: ShipmentStatus.UNKNOWN, metadata: JSON.parse(JSON.stringify(RECOVERY_METADATA)), bookingAttemptId: OWNER, bookingAttemptStartedAt: new Date('2026-11-21T03:00:00Z') });
const ownedPending = () => build({ status: ShipmentStatus.PENDING, bookingAttemptId: OWNER, bookingAttemptStartedAt: new Date() });

// ---------------------------------------------------------------------------
describe('B1/B2: an UNKNOWN shipment is resolved only by reconciliation', () => {
  it.each([ShipmentStatus.FAILED, ShipmentStatus.RATE_SELECTED, ShipmentStatus.PENDING, ShipmentStatus.CREATED, ShipmentStatus.CANCELLED])(
    'refuses status UNKNOWN -> %s and changes nothing',
    async (status) => {
      const h = unknownShipment();
      const error = await h.service.updateShipment('sh1', { status } as never).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain('/admin/orders/o1/shipment/reconcile');
      expect(h.update).not.toHaveBeenCalled();
      expect(h.row).toMatchObject({ status: ShipmentStatus.UNKNOWN, bookingAttemptId: OWNER, metadata: RECOVERY_METADATA });
    },
  );

  it.each([CAPTURED_AWB, 'CO.EMSULAR-20261121-8-OTHER1'])('refuses writing an AWB (%s) - even the captured one - through the generic edit', async (awb) => {
    const h = unknownShipment();
    await expect(h.service.updateShipment('sh1', { trackingNumber: awb } as never)).rejects.toBeInstanceOf(ConflictException);
    expect(h.row.trackingNumber).toBeNull();
    expect(h.update).not.toHaveBeenCalled();
  });

  it.each([
    ['provider', { provider: 'jne' }],
    ['service', { service: 'PAXEL_SAMEDAY' }],
    ['cost', { cost: 1 }],
    ['trackingUrl', { trackingUrl: 'https://track.example/x' }],
    ['metadata', { metadata: { note: 'checked' } }],
  ])('refuses a %s change', async (_label, dto) => {
    const h = unknownShipment();
    await expect(h.service.updateShipment('sh1', dto as never)).rejects.toBeInstanceOf(ConflictException);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('accepts the edit form resubmitting the unchanged values (no-op), leaving recovery state intact', async () => {
    const h = unknownShipment();
    await h.service.updateShipment('sh1', { provider: 'paxel', service: 'PAXEL_NEXTDAY', cost: 30000, status: ShipmentStatus.UNKNOWN, trackingNumber: '', trackingUrl: '' } as never);
    expect(h.update).not.toHaveBeenCalled(); // nothing written at all
    expect(h.row).toMatchObject({ status: ShipmentStatus.UNKNOWN, trackingNumber: null, bookingAttemptId: OWNER, metadata: RECOVERY_METADATA });
  });

  it('B7: a metadata edit cannot clear reconciliationRequired or replace booking.unrecorded', async () => {
    const h = unknownShipment();
    // Every recovery key is system-owned, so this edit changes nothing (a no-op)...
    await h.service.updateShipment('sh1', { metadata: { reconciliationRequired: false, booking: { unrecorded: null } } } as never);
    expect(h.row.metadata).toEqual(RECOVERY_METADATA);
    expect(h.row.status).toBe(ShipmentStatus.UNKNOWN);
  });
});

// ---------------------------------------------------------------------------
describe('B3: a PENDING shipment owned by a booking attempt cannot be touched', () => {
  it.each([
    ['reset to FAILED', { status: ShipmentStatus.FAILED }],
    ['reset to RATE_SELECTED', { status: ShipmentStatus.RATE_SELECTED }],
    ['given an AWB', { trackingNumber: '0291492600000999' }],
    ['retargeted', { service: 'PAXEL_SAMEDAY' }],
    ['metadata-edited', { metadata: { paxel: { pickupDatetime: '2026-11-24T10:00:00.000Z' } } }],
  ])('refuses being %s; owner token and lease untouched', async (_label, dto) => {
    const h = ownedPending();
    const startedAt = h.row.bookingAttemptStartedAt;
    const error = await h.service.updateShipment('sh1', dto as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toMatch(/booking attempt owns this shipment/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: OWNER, bookingAttemptStartedAt: startedAt, trackingNumber: null });
  });

  it('the owner columns are not part of the edit contract at all (rejected by the global ValidationPipe)', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta: ArgumentMetadata = { type: 'body', metatype: UpdateShipmentDto };
    await expect(pipe.transform({ bookingAttemptId: null }, meta)).rejects.toBeDefined();
    await expect(pipe.transform({ bookingAttemptStartedAt: '2020-01-01T00:00:00Z' }, meta)).rejects.toBeDefined();
    await expect(pipe.transform({ cost: 1 }, meta)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('B4: an edit racing a booking claim never resets the claim', () => {
  it.each([
    ['plain edit', { status: ShipmentStatus.FAILED }],
    ['metadata edit', { status: ShipmentStatus.FAILED, metadata: { note: 'x' } }],
  ])('%s: checked on RATE_SELECTED, but a claim lands before the write -> 409, claim intact', async (_label, dto) => {
    const h = build({ status: ShipmentStatus.RATE_SELECTED });
    h.setBetween(() => Object.assign(h.row, { status: ShipmentStatus.PENDING, bookingAttemptId: OWNER, bookingAttemptStartedAt: new Date() }));
    await expect(h.service.updateShipment('sh1', dto as never)).rejects.toThrow(/changed while it was being edited/);
    expect(h.row).toMatchObject({ status: ShipmentStatus.PENDING, bookingAttemptId: OWNER });
  });
});

// ---------------------------------------------------------------------------
describe('B5/B6: delete never reopens booking or destroys recovery evidence', () => {
  it('refuses deleting an UNKNOWN shipment', async () => {
    const h = unknownShipment();
    await expect(h.service.deleteShipment('sh1')).rejects.toThrow(/reconcile/);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('refuses deleting a PENDING shipment owned by a booking attempt', async () => {
    const h = ownedPending();
    await expect(h.service.deleteShipment('sh1')).rejects.toBeInstanceOf(ConflictException);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('refuses deleting a shipment that records a courier-issued AWB, even after reconciliation', async () => {
    const h = build({ status: ShipmentStatus.FAILED, metadata: { booking: { unrecorded: RECOVERY_METADATA.booking.unrecorded, reconciliation: { outcome: 'not_booked', cancelledAtCourier: true } } } });
    await expect(h.service.deleteShipment('sh1')).rejects.toThrow(/booking\.unrecorded/);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('a delete racing a claim is refused (compare-and-set)', async () => {
    const h = build({ status: ShipmentStatus.RATE_SELECTED });
    h.setBetween(() => Object.assign(h.row, { status: ShipmentStatus.PENDING, bookingAttemptId: OWNER }));
    await expect(h.service.deleteShipment('sh1')).rejects.toThrow(/changed while it was being deleted/);
    expect(h.row.status).toBe(ShipmentStatus.PENDING);
  });

  it('an ordinary unbooked draft is still deletable', async () => {
    const h = build({ status: ShipmentStatus.RATE_SELECTED });
    await h.service.deleteShipment('sh1');
    expect(h.remove).toHaveBeenCalledWith({ where: { id: 'sh1', status: ShipmentStatus.RATE_SELECTED, trackingNumber: null, bookingAttemptId: null } });
  });
});

// ---------------------------------------------------------------------------
describe('ordinary shipments keep their legitimate edits', () => {
  it.each([
    ['FAILED -> RATE_SELECTED', { status: ShipmentStatus.FAILED }, { status: ShipmentStatus.RATE_SELECTED }],
    ['a cost correction', { status: ShipmentStatus.RATE_SELECTED }, { cost: 25000 }],
    ['recording a manually booked AWB (manual fulfilment)', { status: ShipmentStatus.FAILED, provider: 'jne', service: 'REG' }, { trackingNumber: '0291492600000555', status: ShipmentStatus.CREATED }],
    ['a legacy PENDING without an owner', { status: ShipmentStatus.PENDING }, { status: ShipmentStatus.FAILED }],
    ['a tracking URL on a booked shipment', { status: ShipmentStatus.CREATED, trackingNumber: '0291492600000556', providerShipmentId: '0291492600000556' }, { trackingUrl: 'https://track.example/556' }],
    ['a FAILED shipment of an earlier owned attempt', { status: ShipmentStatus.FAILED, bookingAttemptId: OWNER }, { status: ShipmentStatus.RATE_SELECTED }],
  ])('%s', async (_label, initial, dto) => {
    const h = build(initial as Partial<Row>);
    await h.service.updateShipment('sh1', dto as never);
    expect(h.row).toMatchObject(dto);
  });

  it('a metadata edit on an ordinary shipment still merges, but never rewrites booking history', async () => {
    const history = { unrecorded: RECOVERY_METADATA.booking.unrecorded, reconciliation: { outcome: 'not_booked', cancelledAtCourier: true } };
    const h = build({ status: ShipmentStatus.FAILED, metadata: { booking: history } });
    await h.service.updateShipment('sh1', { metadata: { note: 'customer called', booking: { unrecorded: null }, reconciliationRequired: true } } as never);
    expect(h.row.metadata).toEqual({ booking: history, note: 'customer called' });
  });
});

// ---------------------------------------------------------------------------
describe('B8: shipments/prepare never rewrites a shipment in recovery or in flight', () => {
  function prepareHarness(row: Record<string, unknown>) {
    const prisma = {
      shipment: { findUnique: jest.fn().mockResolvedValue({ id: 'sh1', orderId: 'o1', trackingNumber: null, metadata: null, ...row }), update: jest.fn(), updateMany: jest.fn() },
      order: { findUnique: jest.fn() },
    };
    const service = new ShipmentService(prisma as never, { get: jest.fn() } as never);
    return { service, prisma };
  }

  it('UNKNOWN: refuses with RECONCILIATION_REQUIRED and writes nothing', async () => {
    const { service, prisma } = prepareHarness({ status: ShipmentStatus.UNKNOWN });
    const outcome = await service.prepareForOrder('o1', { pickupAtIso: '2026-11-24T10:00:00.000Z', service: 'PAXEL_SAMEDAY' });
    expect(outcome).toEqual({ ok: false, status: ShipmentStatus.UNKNOWN, error: RECONCILIATION_REQUIRED });
    expect(prisma.shipment.update).not.toHaveBeenCalled();
    expect(prisma.shipment.updateMany).not.toHaveBeenCalled();
  });

  it('owned PENDING: refuses with BOOKING_IN_PROGRESS and writes nothing', async () => {
    const { service, prisma } = prepareHarness({ status: ShipmentStatus.PENDING, bookingAttemptId: OWNER });
    const outcome = await service.prepareForOrder('o1', { pickupAtIso: '2026-11-24T10:00:00.000Z' });
    expect(outcome).toEqual({ ok: false, status: ShipmentStatus.PENDING, error: BOOKING_IN_PROGRESS });
    expect(prisma.shipment.update).not.toHaveBeenCalled();
  });
});
