import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';
import {
  ADMIN_ORDER_SEARCH_MAX_LENGTH,
  ListAdminOrdersQueryDto,
} from '../../src/modules/admin/application/dto/admin-operations.dto';

/**
 * Incident BMS-20261118-CKK0SJS2: the admin order search only filtered the 20
 * orders of the loaded page, so an order at position 133 could never be found.
 * Search is now a server-side filter of GET /admin/orders.
 */

// Same options as main.ts (whitelist + forbidNonWhitelisted + transform).
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const validate = (query: Record<string, unknown>) =>
  pipe.transform(query, { type: 'query', metatype: ListAdminOrdersQueryDto }) as Promise<ListAdminOrdersQueryDto>;

describe('ListAdminOrdersQueryDto.search validation', () => {
  it('accepts a search term and trims surrounding whitespace', async () => {
    const dto = await validate({ search: '  BMS-20261118-CKK0SJS2 \t' });
    expect(dto.search).toBe('BMS-20261118-CKK0SJS2');
  });

  it('treats a blank search as no search', async () => {
    expect((await validate({ search: '   ' })).search).toBeUndefined();
    expect((await validate({})).search).toBeUndefined();
  });

  it(`accepts exactly ${ADMIN_ORDER_SEARCH_MAX_LENGTH} characters and rejects more`, async () => {
    await expect(validate({ search: 'a'.repeat(ADMIN_ORDER_SEARCH_MAX_LENGTH) })).resolves.toBeDefined();
    await expect(validate({ search: 'a'.repeat(ADMIN_ORDER_SEARCH_MAX_LENGTH + 1) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('measures the limit after trimming', async () => {
    const dto = await validate({ search: `   ${'a'.repeat(ADMIN_ORDER_SEARCH_MAX_LENGTH)}   ` });
    expect(dto.search).toHaveLength(ADMIN_ORDER_SEARCH_MAX_LENGTH);
  });

  it('rejects a repeated (array) search parameter', async () => {
    await expect(validate({ search: ['a', 'b'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still rejects unknown query parameters', async () => {
    await expect(validate({ q: 'BMS' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ orderNumber: 'BMS' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('combines with status, paymentStatus and paging', async () => {
    const dto = await validate({ search: 'ckk0', status: 'PROCESSING', paymentStatus: 'PAID', page: '2', limit: '10' });
    expect(dto).toMatchObject({ search: 'ckk0', status: 'PROCESSING', paymentStatus: 'PAID', page: 2, limit: 10 });
  });
});

// ---- in-memory order store that evaluates the where shape listOrders builds ----

type Row = {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: Date;
  deletedAt: Date | null;
  user: { name: string | null; email: string };
  payment: { status: string } | null;
  shipment: null;
};

type StringFilter = { contains: string; mode?: 'insensitive' };

function matchString(value: string | null | undefined, f: StringFilter): boolean {
  if (value == null) return false;
  return f.mode === 'insensitive'
    ? value.toLowerCase().includes(f.contains.toLowerCase())
    : value.includes(f.contains);
}

type Where = {
  deletedAt?: null;
  status?: string;
  payment?: { status: string };
  OR?: Where[];
  orderNumber?: StringFilter;
  user?: Partial<Record<'name' | 'email', StringFilter>>;
};

// Evaluates exactly the operators listOrders uses; anything else fails loudly.
function matches(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    switch (key) {
      case 'deletedAt':
        if (cond !== null) throw new Error('unexpected deletedAt filter');
        if (row.deletedAt !== null) return false;
        break;
      case 'status':
        if (row.status !== cond) return false;
        break;
      case 'payment':
        if (!row.payment || row.payment.status !== (cond as { status: string }).status) return false;
        break;
      case 'OR':
        if (!(cond as Where[]).some((branch) => matches(row, branch))) return false;
        break;
      case 'orderNumber':
        if (!matchString(row.orderNumber, cond as StringFilter)) return false;
        break;
      case 'user': {
        const userWhere = cond as NonNullable<Where['user']>;
        for (const [field, f] of Object.entries(userWhere)) {
          if (f && !matchString(row.user[field as 'name' | 'email'], f)) return false;
        }
        break;
      }
      default:
        throw new Error(`unsupported where key in test store: ${key}`);
    }
  }
  return true;
}

function storeService(rows: Row[]) {
  const order = {
    findMany: jest.fn(async (args: { where: Where; skip: number; take: number }) =>
      rows
        .filter((r) => matches(r, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(args.skip, args.skip + args.take),
    ),
    count: jest.fn(async (args: { where: Where }) => rows.filter((r) => matches(r, args.where)).length),
  };
  return { service: new AdminService({ order } as never, {} as never), order };
}

const TARGET = 'BMS-20261118-CKK0SJS2';

/** The production shape: the target order followed by 132 newer orders (it sits at position 133). */
function incidentDataset(): Row[] {
  const base = Date.UTC(2026, 10, 18, 6, 11, 38);
  const rows: Row[] = [
    {
      id: 'target',
      orderNumber: TARGET,
      status: 'PROCESSING',
      createdAt: new Date(base),
      deletedAt: null,
      user: { name: 'Pelanggan Target', email: 'target.customer@example.test' },
      payment: { status: 'PAID' },
      shipment: null,
    },
  ];
  for (let i = 1; i <= 132; i++) {
    rows.push({
      id: `newer-${i}`,
      orderNumber: `BMS-20261118-N${String(i).padStart(7, '0')}`,
      status: i % 3 === 0 ? 'PROCESSING' : 'PENDING',
      createdAt: new Date(base + i * 60_000),
      deletedAt: null,
      user: { name: `Pelanggan ${i}`, email: `customer${i}@example.test` },
      payment: { status: i % 3 === 0 ? 'PAID' : 'PENDING' },
      shipment: null,
    });
  }
  // A soft-deleted order that matches every search below must never appear.
  rows.push({
    id: 'deleted',
    orderNumber: 'BMS-20261118-CKK0SJS9',
    status: 'PROCESSING',
    createdAt: new Date(base + 999 * 60_000),
    deletedAt: new Date(base + 1000 * 60_000),
    user: { name: 'Pelanggan Target', email: 'target.customer@example.test' },
    payment: { status: 'PAID' },
    shipment: null,
  });
  return rows;
}

describe('AdminService.listOrders server-side search', () => {
  it('reproduces the incident: without search the target order is not on page 1 (position 133)', async () => {
    const { service } = storeService(incidentDataset());
    const page1 = await service.listOrders({});
    expect(page1.total).toBe(133);
    expect(page1.items.map((o: { id: string }) => o.id)).not.toContain('target');
    const page7 = await service.listOrders({ page: 7, limit: 20 });
    expect(page7.items.map((o: { id: string }) => o.id)).toContain('target');
  });

  it.each([
    ['exact order number', TARGET],
    ['lowercase pasted order number', TARGET.toLowerCase()],
    ['partial order number', 'CKK0SJS2'],
    ['partial lowercase suffix', 'ckk0'],
  ])('finds the oldest order on page 1 by %s', async (_label, search) => {
    const { service } = storeService(incidentDataset());
    const res = await service.listOrders({ search });
    expect(res.page).toBe(1);
    expect(res.items.map((o: { id: string }) => o.id)).toEqual(['target']);
    expect(res.total).toBe(1);
    expect(res.totalPages).toBe(1);
  });

  it('finds by customer name (case-insensitive, partial)', async () => {
    const { service } = storeService(incidentDataset());
    const res = await service.listOrders({ search: 'pelanggan TARGET' });
    expect(res.items.map((o: { id: string }) => o.id)).toEqual(['target']);
  });

  it('finds by customer email (case-insensitive, partial)', async () => {
    const { service } = storeService(incidentDataset());
    const res = await service.listOrders({ search: 'TARGET.CUSTOMER@' });
    expect(res.items.map((o: { id: string }) => o.id)).toEqual(['target']);
  });

  it('combines search with status PROCESSING and paymentStatus PAID (AND, not OR)', async () => {
    const { service } = storeService(incidentDataset());
    const hit = await service.listOrders({ search: 'ckk0sjs2', status: 'PROCESSING' as never, paymentStatus: 'PAID' as never });
    expect(hit.items.map((o: { id: string }) => o.id)).toEqual(['target']);
    const miss = await service.listOrders({ search: 'ckk0sjs2', status: 'PENDING' as never });
    expect(miss.items).toEqual([]);
    expect(miss.total).toBe(0);
    const missPay = await service.listOrders({ search: 'ckk0sjs2', paymentStatus: 'PENDING' as never });
    expect(missPay.total).toBe(0);
  });

  it('a broad search paginates server-side with a consistent total', async () => {
    const { service } = storeService(incidentDataset());
    const res = await service.listOrders({ search: 'bms-20261118', page: 2, limit: 50 });
    expect(res.total).toBe(133);
    expect(res.totalPages).toBe(3);
    expect(res.items).toHaveLength(50);
  });

  it('never returns soft-deleted orders, even when they match the search', async () => {
    const { service } = storeService(incidentDataset());
    const res = await service.listOrders({ search: 'CKK0SJS' });
    expect(res.items.map((o: { id: string }) => o.id)).toEqual(['target']);
  });

  it('findMany and count receive the identical where clause, with search ANDed to the other filters', async () => {
    const { service, order } = storeService(incidentDataset());
    await service.listOrders({ search: 'ckk0', status: 'PROCESSING' as never, paymentStatus: 'PAID' as never });
    const where = order.findMany.mock.calls[0][0].where;
    expect(order.count).toHaveBeenCalledWith({ where });
    expect(where).toMatchObject({
      deletedAt: null,
      status: 'PROCESSING',
      payment: { status: 'PAID' },
      OR: [
        { orderNumber: { contains: 'ckk0', mode: 'insensitive' } },
        { user: { name: { contains: 'ckk0', mode: 'insensitive' } } },
        { user: { email: { contains: 'ckk0', mode: 'insensitive' } } },
      ],
    });
  });

  it('no search adds no OR clause and keeps createdAt desc ordering', async () => {
    const { service, order } = storeService(incidentDataset());
    await service.listOrders({ search: '   ' });
    const args = order.findMany.mock.calls[0][0] as { where: Record<string, unknown>; orderBy?: unknown };
    expect(args.where.OR).toBeUndefined();
    expect(order.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
  });
});
