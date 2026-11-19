import { BadRequestException } from '@nestjs/common';
import { StockTransferService } from '../../src/modules/inventory/stock-transfer.service';

/**
 * StockTransferService.adjustStock — "Stok Produk" admin adjustment.
 * Production finding (2026-11-18, product 9aa8c8db): stock was set to 12 while 13
 * units were held for pending orders. Stock may never be set below `reserved`,
 * and the adjustment runs in one transaction under the row lock.
 * (Real concurrency is proven in test/integration/stock-adjust-concurrency.int-spec.ts.)
 */

type Row = { id: string; productId: string; outletId: string; stock: number; reserved: number; available: number };

function harness(initial: Partial<Row> | null) {
  let row: Row | null = initial
    ? { id: 'pi-1', productId: 'p1', outletId: 'o1', stock: 0, reserved: 0, available: 0, ...initial }
    : null;
  const calls: string[] = [];
  const tx = {
    productInventory: {
      createMany: jest.fn(async ({ data }: { data: Array<Omit<Row, 'id'>> }) => {
        calls.push('ensure');
        if (row) return { count: 0 }; // ON CONFLICT DO NOTHING
        row = { id: 'pi-new', ...data[0] };
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { stock: number; available: number } }) => {
        calls.push('update');
        if (!row || row.id !== where.id) throw new Error('unexpected update target');
        row = { ...row, ...data };
        return row;
      }),
    },
    $queryRaw: jest.fn(async (sql: { strings?: string[] }) => {
      calls.push('lock');
      expect((sql.strings ?? []).join(' ')).toMatch(/FOR UPDATE/);
      return row ? [{ id: row.id, stock: row.stock, reserved: row.reserved }] : [];
    }),
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new StockTransferService(prisma as never);
  return { service, prisma, tx, calls, get row() { return row; } };
}

const adjust = (h: ReturnType<typeof harness>, stock: number) =>
  h.service.adjustStock({ productId: 'p1', outletId: 'o1', stock, note: 'stock opname' } as never, 'admin-1');

describe('StockTransferService.adjustStock', () => {
  it('raises stock above the reserved quantity and recomputes available from the locked row', async () => {
    const h = harness({ stock: 10, reserved: 4, available: 6 });
    const result = await adjust(h, 15);
    expect(result).toMatchObject({ stock: 15, reserved: 4, available: 11 });
    expect(h.calls).toEqual(['ensure', 'lock', 'update']); // locked before it writes
  });

  it('lowers stock to a value still above reserved', async () => {
    const h = harness({ stock: 10, reserved: 4, available: 6 });
    expect(await adjust(h, 5)).toMatchObject({ stock: 5, available: 1 });
  });

  it('accepts stock EQUAL to the reserved quantity (available becomes 0)', async () => {
    const h = harness({ stock: 10, reserved: 4, available: 6 });
    expect(await adjust(h, 4)).toMatchObject({ stock: 4, reserved: 4, available: 0 });
  });

  it('rejects stock BELOW the reserved quantity: nothing written, nothing audited', async () => {
    const h = harness({ stock: 13, reserved: 13, available: 0 }); // the 9aa8c8db situation
    await expect(adjust(h, 12)).rejects.toBeInstanceOf(BadRequestException);
    await expect(adjust(h, 12)).rejects.toThrow(/below the reserved quantity: 13 unit\(s\)/);
    expect(h.tx.productInventory.update).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({ stock: 13, reserved: 13, available: 0 });
  });

  it('rejects any value below reserved, including 0', async () => {
    const h = harness({ stock: 3, reserved: 1, available: 2 });
    await expect(adjust(h, 0)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.row).toMatchObject({ stock: 3, reserved: 1 });
  });

  it('creates a missing Stok Produk row (reserved 0) and audits previousStock null', async () => {
    const h = harness(null);
    const result = await adjust(h, 7);
    expect(result).toMatchObject({ stock: 7, reserved: 0, available: 7 });
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'inventory.adjust',
        after: expect.objectContaining({ newStock: 7, previousStock: null, byAdminId: 'admin-1', note: 'stock opname' }),
      }),
    });
  });

  it('audits the previous stock of an existing row, after the transaction', async () => {
    const h = harness({ stock: 10, reserved: 0, available: 10 });
    await adjust(h, 8);
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ after: expect.objectContaining({ newStock: 8, previousStock: 10 }) }),
    });
  });

  it('runs inside ONE transaction', async () => {
    const h = harness({ stock: 1, reserved: 0, available: 1 });
    await adjust(h, 2);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
