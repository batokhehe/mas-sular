import { PaymentMethod, ReservationStatus } from '@prisma/client';
import { loadAvailableStock } from '../../src/modules/inventory/stock-availability';
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';

/**
 * Business rule: stock availability comes ONLY from "Stok Produk" (ProductInventory,
 * per outlet). The master Product.stock is never the source of truth - not for the
 * storefront display, not for checkout validation, not for reservations.
 */

type Row = { productId: string; stock: number; reserved: number };
const reader = (rows: Row[]) => ({ productInventory: { findMany: jest.fn().mockResolvedValue(rows) } });

describe('loadAvailableStock (Stok Produk availability)', () => {
  it('is the best single active outlet (stock - reserved), never a sum across outlets', async () => {
    const db = reader([
      { productId: 'p1', stock: 10, reserved: 4 }, // 6
      { productId: 'p1', stock: 5, reserved: 0 }, // 5
    ]);
    const available = await loadAvailableStock(db, ['p1']);
    expect(available.get('p1')).toBe(6);
  });

  it('only reads active outlets, and only the requested products', async () => {
    const db = reader([]);
    await loadAvailableStock(db, ['p1', 'p2', 'p1']);
    expect(db.productInventory.findMany).toHaveBeenCalledWith({
      where: { productId: { in: ['p1', 'p2'] }, outlet: { isActive: true } },
      select: { productId: true, stock: true, reserved: true },
    });
  });

  it('a product without any Stok Produk row is unavailable (0)', async () => {
    const available = await loadAvailableStock(reader([]), ['no-row']);
    expect(available.get('no-row')).toBe(0);
  });

  it('never negative: holds above stock (stock edited below reserved) read as 0', async () => {
    const available = await loadAvailableStock(reader([{ productId: 'p1', stock: 12, reserved: 13 }]), ['p1']);
    expect(available.get('p1')).toBe(0);
  });

  it('no products -> no query', async () => {
    const db = reader([]);
    expect((await loadAvailableStock(db, [])).size).toBe(0);
    expect(db.productInventory.findMany).not.toHaveBeenCalled();
  });
});

describe('public catalog exposes Stok Produk availability, never the master stock', () => {
  const MASTER = { id: 'p1', name: 'Bakso', slug: 'bakso', price: 20_000 };

  function repo(rows: Row[]) {
    const findMany = jest.fn().mockResolvedValue([MASTER]);
    const findFirst = jest.fn().mockResolvedValue(MASTER);
    const prisma = { product: { findMany, findFirst }, productInventory: { findMany: jest.fn().mockResolvedValue(rows) } };
    return { repo: new PrismaCatalogRepository(prisma as never), findMany, findFirst };
  }

  it('list: master stock is omitted at the query and availableStock comes from Stok Produk', async () => {
    const { repo: catalog, findMany } = repo([{ productId: 'p1', stock: 0, reserved: 0 }]);
    const [product] = (await catalog.listProducts({} as never)) as Array<Record<string, unknown>>;
    expect(findMany.mock.calls[0][0].omit).toEqual({ sku: true, stock: true });
    expect(product.availableStock).toBe(0);
    expect(product).not.toHaveProperty('stock');
  });

  it('detail: Stok Produk > 0 shows as available even if the master stock were 0', async () => {
    const { repo: catalog, findFirst } = repo([{ productId: 'p1', stock: 7, reserved: 2 }]);
    const product = (await catalog.getProduct('bakso')) as Record<string, unknown>;
    expect(findFirst.mock.calls[0][0].omit).toEqual({ sku: true, stock: true });
    expect(product.availableStock).toBe(5);
  });
});

/**
 * A stateful single-outlet Stok Produk + reservation ledger, enough to run
 * reserve -> release and check that availability and the ledger stay consistent.
 */
function ledgerHarness(stock: number) {
  const pi = { id: 'pi-1', productId: 'p1', outletId: 'outlet-1', stock, reserved: 0 };
  const reservations: Array<{ id: string; orderId: string; productId: string; outletId: string; reservedQty: number; committedQty: number; status: ReservationStatus }> = [];
  const tx = {
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'outlet-1' }) },
    productInventory: {
      findUnique: jest.fn(async () => ({ id: pi.id })),
      update: jest.fn(async ({ data }: { data: { stock?: { increment?: number; decrement?: number }; reserved?: { increment?: number; decrement?: number } } }) => {
        pi.stock += (data.stock?.increment ?? 0) - (data.stock?.decrement ?? 0);
        pi.reserved += (data.reserved?.increment ?? 0) - (data.reserved?.decrement ?? 0);
        return {};
      }),
      findMany: jest.fn(async () => [{ productId: pi.productId, stock: pi.stock, reserved: pi.reserved }]),
    },
    $queryRaw: jest.fn(async () => [{ id: pi.id, stock: pi.stock, reserved: pi.reserved }]),
    inventoryReservation: {
      create: jest.fn(async ({ data }: { data: (typeof reservations)[number] }) => {
        const row = { ...data, id: `r${reservations.length + 1}`, committedQty: 0 };
        reservations.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: { orderId: string; status: { in: ReservationStatus[] } | ReservationStatus } }) =>
        reservations.filter(
          (r) => r.orderId === where.orderId && (typeof where.status === 'object' ? where.status.in.includes(r.status) : r.status === where.status),
        ),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; status: ReservationStatus }; data: { status: ReservationStatus; committedQty?: number } }) => {
        const row = reservations.find((r) => r.id === where.id && r.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    inventoryReservationHistory: { create: jest.fn() },
    product: { update: jest.fn() },
  };
  const prisma = { ...tx, $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) };
  const service = new InventoryReservationService(prisma as never);
  const ledgerReserved = () => reservations.filter((r) => r.status === ReservationStatus.RESERVED).reduce((s, r) => s + r.reservedQty, 0);
  return { service, tx, pi, reservations, ledgerReserved };
}

describe('reservation ledger over Stok Produk', () => {
  it('reserve then release restores availability; the reserved column always equals the RESERVED ledger', async () => {
    const h = ledgerHarness(5);
    expect(await h.service.availableFor('p1')).toBe(5);

    await h.service.reserveForOrder(h.tx as never, { orderId: 'o1', items: [{ productId: 'p1', quantity: 3 }], paymentMethod: PaymentMethod.BANK_TRANSFER });
    expect(await h.service.availableFor('p1')).toBe(2);
    expect(h.pi.reserved).toBe(h.ledgerReserved());

    await h.service.releaseForOrder(h.tx as never, 'o1');
    expect(await h.service.availableFor('p1')).toBe(5);
    expect(h.pi.reserved).toBe(h.ledgerReserved());
    expect(h.pi.stock).toBe(5);
    expect(h.tx.product.update).not.toHaveBeenCalled(); // master stock untouched
  });

  it('commit deducts Stok Produk exactly once (no double deduction) and frees the hold', async () => {
    const h = ledgerHarness(5);
    await h.service.reserveForOrder(h.tx as never, { orderId: 'o1', items: [{ productId: 'p1', quantity: 2 }], paymentMethod: PaymentMethod.BANK_TRANSFER });
    expect(await h.service.commitForOrder(h.tx as never, 'o1')).toBe(1);
    expect(await h.service.commitForOrder(h.tx as never, 'o1')).toBe(0); // already committed: nothing again
    expect(h.pi).toMatchObject({ stock: 3, reserved: 0 });
    expect(await h.service.availableFor('p1')).toBe(3);
    expect(h.tx.product.update).not.toHaveBeenCalled();
  });

  it('the last unit cannot be sold twice: the second checkout is refused', async () => {
    const h = ledgerHarness(1);
    await h.service.reserveForOrder(h.tx as never, { orderId: 'oA', items: [{ productId: 'p1', quantity: 1 }], paymentMethod: PaymentMethod.QRIS });
    await expect(
      h.service.reserveForOrder(h.tx as never, { orderId: 'oB', items: [{ productId: 'p1', quantity: 1 }], paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toThrow('Insufficient available stock');
    expect(h.pi.reserved).toBe(1);
    expect(h.reservations).toHaveLength(1);
  });
});
