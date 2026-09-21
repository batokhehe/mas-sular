import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { ListAdminShipmentsQueryDto } from '../../src/modules/admin/application/dto/admin-operations.dto';
import {
  activeShippingWhere,
  SHIPPING_ACTIVE_SHIPMENT_STATUSES,
  SHIPPING_EXCLUDED_ORDER_STATUSES,
  SHIPPING_EXCLUDED_SHIPMENT_STATUSES,
} from '../../src/modules/admin/shipping-list-scope';

/**
 * Admin → Shipping list scope (GET /admin/shipments?scope=active). The rule is applied
 * in the database query so paging and totals match what the page shows. The in-memory
 * shipment table below evaluates exactly the Prisma operators the rule uses (AND,
 * status equality / notIn, relation order.status notIn); the same rule runs against
 * real PostgreSQL in test/integration/admin-shipping-list-scope.int-spec.ts.
 */

type Row = { id: string; createdAt: number; status: ShipmentStatus; order: { orderNumber: string; status: OrderStatus } };
type Where = { AND?: Where[]; status?: string | { notIn?: string[] }; order?: { status?: { notIn?: string[] } } };
type FindArgs = { where?: Where; skip?: number; take?: number };

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  if (Array.isArray(where.AND) && !where.AND.every((w: Where) => matches(row, w))) return false;
  const status = where.status;
  if (typeof status === 'string' && row.status !== status) return false;
  if (status && typeof status === 'object' && status.notIn?.includes(row.status)) return false;
  const orderStatus = where.order?.status;
  if (orderStatus?.notIn?.includes(row.order.status)) return false;
  return true;
}

function shipmentTable(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt); // orderBy createdAt desc
  return {
    findMany: jest.fn(async ({ where, skip = 0, take = 20 }: FindArgs) => sorted.filter((r) => matches(r, where)).slice(skip, skip + take)),
    count: jest.fn(async ({ where }: FindArgs) => sorted.filter((r) => matches(r, where)).length),
  };
}

let seq = 0;
const row = (status: ShipmentStatus, orderStatus: OrderStatus = OrderStatus.SHIPPED): Row => {
  seq += 1;
  return { id: `s${seq}`, createdAt: seq, status, order: { orderNumber: `BMS-${String(seq).padStart(4, '0')}`, status: orderStatus } };
};

async function list(rows: Row[], query: Record<string, unknown>) {
  const shipment = shipmentTable(rows);
  const service = new AdminService({ shipment } as never, {} as never);
  const res = (await service.listShipments(query as never)) as unknown as { items: Row[]; total: number; totalPages: number; page: number };
  return { res, shipment };
}

describe('the rule (derived from the real enums, nothing invented)', () => {
  it('excludes exactly DELIVERED and CANCELLED shipments; every other ShipmentStatus is active', () => {
    expect(SHIPPING_EXCLUDED_SHIPMENT_STATUSES).toEqual([ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED]);
    expect(SHIPPING_ACTIVE_SHIPMENT_STATUSES).toEqual([
      ShipmentStatus.PENDING,
      ShipmentStatus.RATE_SELECTED,
      ShipmentStatus.CREATED,
      ShipmentStatus.WAITING_PICKUP,
      ShipmentStatus.PICKED_UP,
      ShipmentStatus.IN_TRANSIT,
      ShipmentStatus.OUT_FOR_DELIVERY,
      ShipmentStatus.FAILED,
      ShipmentStatus.UNKNOWN,
    ]);
  });

  it('also excludes shipments of final orders: DELIVERED, COMPLETED, CANCELLED (expired payments cancel the order)', () => {
    expect(SHIPPING_EXCLUDED_ORDER_STATUSES).toEqual([OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.CANCELLED]);
  });

  it('there is no CANCELED / EXPIRED / READY_TO_SHIP / BOOKED / PROCESSING / SHIPPED shipment status in this codebase', () => {
    for (const name of ['CANCELED', 'EXPIRED', 'READY_TO_SHIP', 'BOOKED', 'PROCESSING', 'SHIPPED']) {
      expect([name, Object.values(ShipmentStatus).includes(name as ShipmentStatus)]).toEqual([name, false]);
    }
    // PROCESSING / SHIPPED exist as ORDER statuses; EXPIRED as a PAYMENT status.
    expect(Object.values(OrderStatus)).toEqual(expect.arrayContaining([OrderStatus.PROCESSING, OrderStatus.SHIPPED]));
  });

  it('is a notIn filter: a shipment status added later is shown, never silently treated as done', () => {
    expect(activeShippingWhere()).toEqual({
      status: { notIn: ['DELIVERED', 'CANCELLED'] },
      order: { status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED'] } },
    });
  });
});

describe('AdminService.listShipments with scope=active', () => {
  beforeEach(() => {
    seq = 0;
  });

  it.each([
    ShipmentStatus.PENDING,
    ShipmentStatus.RATE_SELECTED,
    ShipmentStatus.CREATED, // "Pengiriman dibuat" - booked with the courier
    ShipmentStatus.WAITING_PICKUP,
    ShipmentStatus.PICKED_UP,
    ShipmentStatus.IN_TRANSIT,
    ShipmentStatus.OUT_FOR_DELIVERY,
    ShipmentStatus.FAILED, // courier gave up - an admin must act
    ShipmentStatus.UNKNOWN, // unknown is never treated as done
  ])('%s → visible', async (status) => {
    const { res } = await list([row(status)], { scope: 'active' });
    expect(res.items.map((r) => r.status)).toEqual([status]);
  });

  it.each([ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED])('%s → hidden', async (status) => {
    const { res } = await list([row(status)], { scope: 'active' });
    expect(res).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it.each([
    [OrderStatus.CANCELLED, 'cancelled / expired-payment order'],
    [OrderStatus.DELIVERED, 'delivered order'],
    [OrderStatus.COMPLETED, 'completed order'],
  ])('an active shipment of a %s (%s) → hidden', async (orderStatus, _label) => {
    const { res } = await list([row(ShipmentStatus.CREATED, orderStatus)], { scope: 'active' });
    expect(res.items).toEqual([]);
  });

  it.each([OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.PACKING, OrderStatus.SHIPPED, OrderStatus.DELIVERING])(
    'an active shipment of an order in %s → visible',
    async (orderStatus) => {
      const { res } = await list([row(ShipmentStatus.PICKED_UP, orderStatus)], { scope: 'active' });
      expect(res.items).toHaveLength(1);
    },
  );

  it('status filter + scope: an active status narrows; a finished status yields nothing', async () => {
    const rows = [row(ShipmentStatus.IN_TRANSIT), row(ShipmentStatus.PICKED_UP), row(ShipmentStatus.DELIVERED), row(ShipmentStatus.IN_TRANSIT, OrderStatus.CANCELLED)];
    const inTransit = await list(rows, { scope: 'active', status: ShipmentStatus.IN_TRANSIT });
    expect(inTransit.res.items.map((r) => r.id)).toEqual(['s1']);
    const delivered = await list(rows, { scope: 'active', status: ShipmentStatus.DELIVERED });
    expect(delivered.res).toMatchObject({ items: [], total: 0 });
  });

  it('pagination counts only the filtered rows: full pages, correct total and page count, newest first', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 25; i += 1) rows.push(row(i % 5 === 0 ? ShipmentStatus.DELIVERED : i % 7 === 0 ? ShipmentStatus.CANCELLED : ShipmentStatus.IN_TRANSIT));
    const visible = rows.filter((r) => r.status === ShipmentStatus.IN_TRANSIT).sort((a, b) => b.createdAt - a.createdAt);
    expect(visible).toHaveLength(17); // 25 rows - 5 DELIVERED (i % 5) - 3 CANCELLED (i = 7, 14, 21)

    const p1 = await list(rows, { scope: 'active', page: 1, limit: 10 });
    const p2 = await list(rows, { scope: 'active', page: 2, limit: 10 });
    expect(p1.res).toMatchObject({ page: 1, total: 17, totalPages: 2 });
    expect(p2.res).toMatchObject({ page: 2, total: 17, totalPages: 2 });
    expect(p1.res.items.map((r) => r.id)).toEqual(visible.slice(0, 10).map((r) => r.id)); // a full first page
    expect(p2.res.items.map((r) => r.id)).toEqual(visible.slice(10).map((r) => r.id));
    // The same filter reaches findMany and count, so totals never disagree with the rows.
    expect(p1.shipment.count.mock.calls[0][0].where).toEqual(p1.shipment.findMany.mock.calls[0][0].where);
  });

  it('empty result: nothing active → an empty page the UI renders with its existing empty state', async () => {
    const { res } = await list([row(ShipmentStatus.DELIVERED), row(ShipmentStatus.CANCELLED)], { scope: 'active' });
    expect(res).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });

  it('without a scope nothing changes: every shipment, the original filter object', async () => {
    const rows = [row(ShipmentStatus.DELIVERED), row(ShipmentStatus.CANCELLED), row(ShipmentStatus.IN_TRANSIT, OrderStatus.CANCELLED)];
    const { res, shipment } = await list(rows, {});
    expect(res.total).toBe(3);
    expect(shipment.findMany.mock.calls[0][0].where).toEqual({ status: undefined });
    const filtered = await list(rows, { status: ShipmentStatus.DELIVERED });
    expect(filtered.shipment.findMany.mock.calls[0][0].where).toEqual({ status: ShipmentStatus.DELIVERED });
    expect(filtered.res.total).toBe(1);
  });
});

describe('ListAdminShipmentsQueryDto.scope', () => {
  const errorsFor = async (query: Record<string, unknown>) =>
    (await validate(plainToInstance(ListAdminShipmentsQueryDto, query))).map((e) => e.property);

  it('accepts only "active" (or no scope)', async () => {
    expect(await errorsFor({})).toEqual([]);
    expect(await errorsFor({ scope: 'active' })).toEqual([]);
    expect(await errorsFor({ scope: 'active', status: 'IN_TRANSIT' })).toEqual([]);
    expect(await errorsFor({ scope: 'all' })).toEqual(['scope']);
    expect(await errorsFor({ scope: 'ACTIVE' })).toEqual(['scope']);
    expect(await errorsFor({ status: 'CANCELED' })).toEqual(['status']); // not a real enum value
  });
});
