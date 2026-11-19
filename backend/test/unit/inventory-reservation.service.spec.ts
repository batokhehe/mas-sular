import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, ReservationStatus } from '@prisma/client';
import { InventoryReservationService } from '../../src/modules/inventory/inventory-reservation.service';

/** The interpolated text of a Prisma.sql template. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqlText(sql: any): string {
  return String(sql?.strings?.join(' ') ?? sql?.sql ?? '');
}

/**
 * The legacy path issues TWO locking reads (BF-017): the Product row, then the
 * RESERVED InventoryReservation rows. Held quantity used to come from a
 * non-locking aggregate, which is exactly what let two checkouts sell the same
 * unit — so these mocks route by SQL text instead of answering both reads alike.
 *
 * `reserved` may be a single number or a queue of successive values, for tests
 * that need the second call to observe the first call's reservation.
 */
function rawMock(opts: { stock?: number; reserved?: number | number[] } = {}) {
  const queue = Array.isArray(opts.reserved) ? [...opts.reserved] : null;
  return jest.fn().mockImplementation(async (sql: unknown) => {
    if (/InventoryReservation/i.test(sqlText(sql))) {
      const held = queue ? (queue.shift() ?? 0) : ((opts.reserved as number) ?? 0);
      return held > 0 ? [{ reservedQty: held }] : [];
    }
    return [{ stock: opts.stock ?? 10 }];
  });
}

function buildTx(overrides: Record<string, unknown> = {}) {
  return {
    outlet: { findFirst: jest.fn().mockResolvedValue({ id: 'outlet-1' }) },
    $queryRaw: rawMock(),
    inventoryReservation: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 0 } }),
      create: jest.fn().mockResolvedValue({ id: 'res-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ reservedQty: 2 }),
    },
    inventoryReservationHistory: { create: jest.fn().mockResolvedValue({}) },
    product: { update: jest.fn().mockResolvedValue({}) },
    productInventory: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

function buildPrisma(tx = buildTx()) {
  return {
    product: { findUnique: jest.fn().mockResolvedValue({ stock: 10 }) },
    inventoryReservation: { aggregate: jest.fn().mockResolvedValue({ _sum: { reservedQty: 3 } }) },
    $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    __tx: tx,
  };
}

function svc(prisma = buildPrisma()) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { service: new InventoryReservationService(prisma as any), prisma };
}

/**
 * Stateful "Stok Produk" (ProductInventory) store for the reservation tests: one
 * row per product at outlet-1. findUnique resolves the row, the FOR UPDATE read
 * returns its CURRENT stock/reserved (so a second checkout sees the first's hold),
 * and update applies the reserved increment. `lockOrder` records each FOR UPDATE.
 */
function piStore(stockByProduct: Record<string, { stock: number; reserved?: number }>) {
  const rows = new Map(
    Object.entries(stockByProduct).map(([productId, v]) => [`pi-${productId}`, { productId, stock: v.stock, reserved: v.reserved ?? 0 }]),
  );
  const lockOrder: string[] = [];
  return {
    rows,
    lockOrder,
    productInventory: {
      findUnique: jest.fn(async ({ where }: { where: { productId_outletId: { productId: string; outletId: string } } }) => {
        const id = `pi-${where.productId_outletId.productId}`;
        return where.productId_outletId.outletId === 'outlet-1' && rows.has(id) ? { id } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { reserved?: { increment: number } } }) => {
        const row = rows.get(where.id)!;
        if (data.reserved?.increment) row.reserved += data.reserved.increment;
        return {};
      }),
      create: jest.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRaw: jest.fn(async (sql: any) => {
      if (!/ProductInventory/i.test(sqlText(sql))) throw new Error(`unexpected raw query: ${sqlText(sql)}`);
      const id = sql.values[0] as string;
      lockOrder.push(rows.get(id)?.productId ?? id);
      const row = rows.get(id);
      return row ? [{ stock: row.stock, reserved: row.reserved }] : [];
    }),
  };
}

function stokProdukTx(stockByProduct: Record<string, { stock: number; reserved?: number }>) {
  const store = piStore(stockByProduct);
  const tx = buildTx({
    productInventory: store.productInventory,
    $queryRaw: store.$queryRaw,
    inventoryReservation: { create: jest.fn().mockResolvedValue({ id: 'res-x' }) },
    inventoryReservationHistory: { create: jest.fn() },
  });
  return { tx, store };
}

const items = [{ productId: 'p1', quantity: 2 }];

describe('InventoryReservationService', () => {
  it('reserves Stok Produk stock when available (creates reservation + history, locks the row)', async () => {
    const { tx, store } = stokProdukTx({ p1: { stock: 10 } });
    const { service } = svc();
    await service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.BANK_TRANSFER });

    expect(store.lockOrder).toEqual(['p1']); // FOR UPDATE on the ProductInventory row
    expect(store.rows.get('pi-p1')!.reserved).toBe(2);
    expect(tx.inventoryReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'o1', productId: 'p1', outletId: 'outlet-1', reservedQty: 2, status: ReservationStatus.RESERVED }) }),
    );
    expect(tx.inventoryReservationHistory.create).toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled(); // master Product.stock never touched
  });

  it('prevents overselling: throws when Stok Produk available < requested', async () => {
    // stock 10, already reserved 9 -> available 1 < 2 requested.
    const { tx } = stokProdukTx({ p1: { stock: 10, reserved: 9 } });
    const { service } = svc();
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.inventoryReservation.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent checkouts: second reservation sees the first hold and is rejected', async () => {
    // Stok Produk stock 3. First reserves 2 (reserved 0 -> 2). Second sees available 1 < 2 -> reject.
    const { tx, store } = stokProdukTx({ p1: { stock: 3 } });
    const { service } = svc();
    await service.reserveForOrder(tx as never, { orderId: 'oA', items, paymentMethod: PaymentMethod.QRIS });
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'oB', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.rows.get('pi-p1')!.reserved).toBe(2); // never oversold
  });

  it('refuses a product with no Stok Produk row, even if the master stock is positive', async () => {
    const { tx } = stokProdukTx({}); // no ProductInventory row at all
    const { service } = svc(); // master product stock is 10 in buildPrisma
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toThrow('Insufficient available stock');
    expect(tx.inventoryReservation.create).not.toHaveBeenCalled();
  });

  it('reserves from Stok Produk even when the master Product.stock is 0', async () => {
    const { tx, store } = stokProdukTx({ p1: { stock: 5 } });
    const prisma = buildPrisma(tx);
    prisma.product.findUnique = jest.fn().mockResolvedValue({ stock: 0 });
    const { service } = svc(prisma);
    await service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS });
    expect(store.rows.get('pi-p1')!.reserved).toBe(2);
  });

  it('refuses when there is no active outlet to reserve at', async () => {
    const { tx } = stokProdukTx({ p1: { stock: 5 } });
    tx.outlet.findFirst = jest.fn().mockResolvedValue(null);
    const { service } = svc();
    await expect(
      service.reserveForOrder(tx as never, { orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS }),
    ).rejects.toThrow('Insufficient available stock');
  });

  it('commits reservations: CAS-transitions RESERVED → COMMITTED, deducts Product.stock', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', reservedQty: 2, outletId: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn().mockResolvedValue({}) },
    });
    const { service } = svc();
    const n = await service.commitForOrder(tx as never, 'o1');
    expect(n).toBe(1);
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', status: ReservationStatus.RESERVED }, // C2: fenced transition
      data: { status: ReservationStatus.COMMITTED, committedQty: 2 },
    });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { decrement: 2 } } });
  });

  // --- Regression: C2 — a reservation expired between snapshot and commit is skipped. ---
  it('commit skips a reservation that lost the CAS (expired concurrently): no deduction, not counted', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', reservedQty: 2, outletId: null }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // expiry worker won
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn() },
    });
    const { service } = svc();
    const n = await service.commitForOrder(tx as never, 'o1');
    expect(n).toBe(0);
    expect(tx.product.update).not.toHaveBeenCalled(); // stock never touched
    expect(tx.inventoryReservationHistory.create).not.toHaveBeenCalled();
  });

  it('releases committed reservations (restocks) and reports handled=true', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', outletId: null, reservedQty: 2, committedQty: 2, status: ReservationStatus.COMMITTED }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn().mockResolvedValue({}) },
    });
    const { service } = svc();
    const result = await service.releaseForOrder(tx as never, 'o1', ReservationStatus.RELEASED);
    expect(result.handled).toBe(true);
    expect(tx.inventoryReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', status: ReservationStatus.COMMITTED }, // CAS on the observed status
      data: { status: ReservationStatus.RELEASED, releasedQty: 2 },
    });
    expect(tx.product.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { stock: { increment: 2 } } });
  });

  it('release skips a reservation whose state changed after the snapshot (no double counter move)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'res-1', productId: 'p1', outletId: null, reservedQty: 2, committedQty: 0, status: ReservationStatus.RESERVED }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // expired concurrently
      },
      inventoryReservationHistory: { create: jest.fn() },
      product: { update: jest.fn() },
    });
    const { service } = svc();
    await service.releaseForOrder(tx as never, 'o1', ReservationStatus.RELEASED);
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryReservationHistory.create).not.toHaveBeenCalled();
  });

  it('release reports handled=false when there are no reservations (legacy order)', async () => {
    const tx = buildTx({ inventoryReservation: { findMany: jest.fn().mockResolvedValue([]) } });
    const { service } = svc();
    const result = await service.releaseForOrder(tx as never, 'o1');
    expect(result.handled).toBe(false);
  });

  it('expireReservation CAS-transitions RESERVED → EXPIRED', async () => {
    const prisma = buildPrisma();
    const { service } = svc(prisma);
    const ok = await service.expireReservation('res-1');
    expect(ok).toBe(true);
    expect(prisma.__tx.inventoryReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1', status: ReservationStatus.RESERVED }, data: expect.objectContaining({ status: ReservationStatus.EXPIRED }) }),
    );
  });

  // --- Regression: C1 — expiry must free the per-outlet ProductInventory hold. ---
  it('expireReservation releases the per-outlet ProductInventory hold (reserved decremented, available recovered)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'res-1', reservedQty: 3, productId: 'p1', outletId: 'outlet-1', inventoryHoldApplied: true }),
        update: jest.fn().mockResolvedValue({}),
      },
      productInventory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pi-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      // C5: the row is re-read FOR UPDATE; available is computed from the locked values.
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'pi-1', stock: 10, reserved: 3 }]),
      inventoryReservationHistory: { create: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    const ok = await service.expireReservation('res-1');

    expect(ok).toBe(true);
    // stock 10, reserved 3 − 3 → available back to 10; stock untouched.
    expect(tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-1' }, data: expect.objectContaining({ reserved: { decrement: 3 }, available: 10 }) }),
    );
    expect(tx.inventoryReservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1' }, data: { releasedQty: 3 } }),
    );
  });

  it('expireReservation of a LEGACY reservation never touches a Stok Produk row that exists TODAY (production drift 11699095)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Same outlet and product as an existing ProductInventory row, but this
        // reservation was created before the row existed: it never placed a hold.
        findUnique: jest.fn().mockResolvedValue({ id: 'res-legacy', reservedQty: 1, productId: 'p1', outletId: 'outlet-1', inventoryHoldApplied: false }),
        update: jest.fn().mockResolvedValue({}),
      },
      productInventory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pi-1' }), // the row DOES exist now
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]), // payment lock: orphan -> proceeds
      inventoryReservationHistory: { create: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    expect(await service.expireReservation('res-legacy')).toBe(true);
    expect(tx.productInventory.update).not.toHaveBeenCalled(); // no hold was placed, none is freed
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1); // only the payment lock; no inventory row lock
  });

  it('commit of a HELD reservation whose Stok Produk row is gone moves nothing - never falls back to Product.stock', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r1', productId: 'p1', outletId: 'outlet-1', reservedQty: 2, status: ReservationStatus.RESERVED, inventoryHoldApplied: true }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]), // the ProductInventory row no longer exists
    });
    const { service } = svc();
    expect(await service.commitForOrder(tx as never, 'o1')).toBe(1);
    expect(tx.productInventory.update).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('release of a RESERVED legacy reservation frees nothing, even when a Stok Produk row exists today', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r1', productId: 'p1', outletId: 'outlet-1', reservedQty: 1, committedQty: 0, status: ReservationStatus.RESERVED, inventoryHoldApplied: false }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productInventory: { findUnique: jest.fn().mockResolvedValue({ id: 'pi-1' }), update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'pi-1', stock: 10, reserved: 0 }]),
    });
    const { service } = svc();
    await service.releaseForOrder(tx as never, 'o1');
    expect(tx.$queryRaw).not.toHaveBeenCalled(); // no hold -> no row lock at all
    expect(tx.productInventory.update).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('release of a COMMITTED held reservation restocks the Stok Produk row, not Product.stock', async () => {
    const tx = buildTx({
      inventoryReservation: {
        findMany: jest.fn().mockResolvedValue([{ id: 'r1', productId: 'p1', outletId: 'outlet-1', reservedQty: 2, committedQty: 2, status: ReservationStatus.COMMITTED, inventoryHoldApplied: true }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productInventory: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'pi-1', stock: 8, reserved: 1 }]),
    });
    const { service } = svc();
    await service.releaseForOrder(tx as never, 'o1');
    expect(tx.productInventory.update).toHaveBeenCalledWith({ where: { id: 'pi-1' }, data: { stock: { increment: 2 }, available: 9 } });
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('expireReservation leaves ProductInventory untouched for legacy reservations (no outlet)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ reservedQty: 2, productId: 'p1', outletId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      inventoryReservationHistory: { create: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    await service.expireReservation('res-1');

    expect(tx.productInventory.findUnique).not.toHaveBeenCalled();
    expect(tx.productInventory.update).not.toHaveBeenCalled();
  });

  it('expireReservation is a no-op when the CAS loses the race (already expired)', async () => {
    const tx = buildTx({
      inventoryReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      productInventory: { findUnique: jest.fn(), update: jest.fn() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = { $transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)), __tx: tx };
    const service = new InventoryReservationService(prisma);

    const ok = await service.expireReservation('res-1');
    expect(ok).toBe(false);
    expect(tx.productInventory.update).not.toHaveBeenCalled();
  });

  it('computes available stock from Stok Produk only (best active outlet stock - reserved), never Product.stock', async () => {
    const prisma = buildPrisma() as ReturnType<typeof buildPrisma> & { productInventory?: unknown };
    prisma.productInventory = {
      findMany: jest.fn().mockResolvedValue([
        { productId: 'p1', stock: 10, reserved: 3 },
        { productId: 'p1', stock: 4, reserved: 0 },
      ]),
    };
    const { service } = svc(prisma as never); // master product stock is 10
    expect(await service.availableFor('p1')).toBe(7);
    expect(await service.availableFor('p-missing')).toBe(0);
  });

  it('reserves against ProductInventory when an outlet is allocated (multi-outlet)', async () => {
    const tx = buildTx({
      productInventory: {
        findUnique: jest.fn().mockResolvedValue({ id: 'pi-1', stock: 10, reserved: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ stock: 10, reserved: 0 }]),
      inventoryReservation: { create: jest.fn().mockResolvedValue({ id: 'res-9' }) },
      inventoryReservationHistory: { create: jest.fn() },
    });
    const { service } = svc();
    await service.reserveForOrder(tx as never, {
      orderId: 'o1', items, paymentMethod: PaymentMethod.QRIS, outletId: 'outlet-1',
    });
    // Reserves against the per-outlet ProductInventory row (not Product.stock).
    expect(tx.productInventory.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'pi-1' }, data: expect.objectContaining({ reserved: { increment: 2 } }) }),
    );
    expect(tx.inventoryReservation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outletId: 'outlet-1' }) }),
    );
  });

  // --- H1 regression: deterministic FOR UPDATE lock ordering (deadlock prevention). ---
  describe('H1 — deterministic lock ordering', () => {
    // Every reservation locks its ProductInventory row FOR UPDATE; capture the
    // product of each lock in call order.
    function capturingTx() {
      const { tx, store } = stokProdukTx({ p1: { stock: 100 }, p2: { stock: 100 } });
      return { tx, lockOrder: store.lockOrder };
    }

    it('locks in identical ascending-productId order for [p1,p2] and reversed [p2,p1]', async () => {
      const { service } = svc();

      const a = capturingTx();
      await service.reserveForOrder(a.tx as never, {
        orderId: 'oA',
        items: [{ productId: 'p2', quantity: 1 }, { productId: 'p1', quantity: 1 }],
        paymentMethod: PaymentMethod.QRIS,
      });

      const b = capturingTx();
      await service.reserveForOrder(b.tx as never, {
        orderId: 'oB',
        items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }],
        paymentMethod: PaymentMethod.QRIS,
      });

      expect(a.lockOrder).toEqual(['p1', 'p2']);
      expect(b.lockOrder).toEqual(['p1', 'p2']);
      expect(a.lockOrder).toEqual(b.lockOrder); // identical regardless of cart order
    });

    it('reservation result is unchanged (every item reserved with correct qty)', async () => {
      const { tx } = capturingTx();
      const { service } = svc();
      await service.reserveForOrder(tx as never, {
        orderId: 'o1',
        items: [{ productId: 'p2', quantity: 3 }, { productId: 'p1', quantity: 2 }],
        paymentMethod: PaymentMethod.QRIS,
      });
      // Both reservations created, quantities intact — ordering only affects lock sequence.
      expect(tx.inventoryReservation.create).toHaveBeenCalledTimes(2);
      const created = (tx.inventoryReservation.create as jest.Mock).mock.calls.map((c) => c[0].data);
      expect(created).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productId: 'p1', reservedQty: 2, status: ReservationStatus.RESERVED }),
          expect.objectContaining({ productId: 'p2', reservedQty: 3, status: ReservationStatus.RESERVED }),
        ]),
      );
    });

    it('rollback behavior unchanged: still throws on insufficient stock (caller tx rolls back)', async () => {
      // p1 has stock, p2 is exhausted -> throws after locking in sorted order.
      const { tx } = stokProdukTx({ p1: { stock: 100 }, p2: { stock: 0 } });
      const { service } = svc();
      await expect(
        service.reserveForOrder(tx as never, {
          orderId: 'o1',
          items: [{ productId: 'p1', quantity: 1 }, { productId: 'p2', quantity: 1 }],
          paymentMethod: PaymentMethod.QRIS,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
