import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { AdminGuard } from '../../src/common/guards/admin.guard';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import {
  AWB_NOT_AVAILABLE,
  formatSlipDate,
  NO_SHIPMENT,
  PACKING_SLIP_SELECT,
  PackingSlipRow,
  SHIPMENT_STATUS_LABEL_ID,
  toPackingSlipView,
} from '../../src/modules/admin/packing-slip';
import { PackingSlipService } from '../../src/modules/admin/packing-slip.service';
import { AdminOperationsController } from '../../src/modules/admin/presentation/admin-operations.controller';

/** P3 Packing Slip — mapper, fallbacks, the narrow read and the route contract. */

function row(over: Partial<PackingSlipRow> = {}): PackingSlipRow {
  return {
    orderNumber: 'BMS-20260917-HV5CPKXA',
    createdAt: new Date('2026-09-17T03:05:00.000Z'), // 10:05 WIB
    deletedAt: null,
    outlet: { name: 'Outlet Buahbatu' },
    reservations: [],
    address: {
      recipientName: 'Budi Santoso',
      addressDetail: 'Jl. Veteran No. 65',
      fullAddress: 'Jl. Veteran No. 65, Bandung',
      phone: '085861470308',
      postalCode: '40112',
      province: { name: 'Jawa Barat' },
      city: { name: 'Kota Bandung' },
      district: { name: 'Sumur Bandung' },
      village: { name: 'Kebon Pisang', postalCode: '40111' },
    },
    items: [
      { productName: 'Baso Urat Jumbo', quantity: 2, toppings: [{ name: 'Bihun' }, { name: 'Mie Kuning' }] },
      { productName: 'Es Teh Manis', quantity: 4, toppings: [] },
    ],
    shipment: { trackingNumber: 'PXL-0123456789', status: ShipmentStatus.CREATED },
    ...over,
  } as PackingSlipRow;
}

describe('toPackingSlipView', () => {
  it('maps every field for a complete order (no prices anywhere)', () => {
    const view = toPackingSlipView(row());
    expect(view).toEqual({
      orderNumber: 'BMS-20260917-HV5CPKXA',
      orderDate: '17 September 2026, 10:05 WIB',
      outlet: 'Outlet Buahbatu',
      recipient: {
        name: 'Budi Santoso',
        address: 'Jl. Veteran No. 65',
        regionLines: ['Kel. Kebon Pisang', 'Kec. Sumur Bandung', 'Kota Bandung', 'Jawa Barat'],
        postalCode: '40112',
        phone: '085861470308',
      },
      items: [
        { no: 1, productName: 'Baso Urat Jumbo', quantity: 2, toppings: ['Bihun', 'Mie Kuning'] },
        { no: 2, productName: 'Es Teh Manis', quantity: 4, toppings: [] },
      ],
      shipment: { trackingNumber: 'PXL-0123456789', awbLabel: 'PXL-0123456789', status: 'CREATED', statusLabel: 'Pengiriman dibuat' },
    });
    expect(JSON.stringify(view)).not.toMatch(/price|amount|payment/i);
  });

  it('formats the date in Asia/Jakarta, deterministically (day boundary included)', () => {
    expect(formatSlipDate(new Date('2026-12-31T17:30:00.000Z'))).toBe('1 Januari 2027, 00:30 WIB');
    expect(formatSlipDate(new Date('2026-03-05T01:00:00.000Z'))).toBe('5 Maret 2026, 08:00 WIB');
  });

  it('outlet: order outlet, else the first reservation outlet, else "—"', () => {
    expect(toPackingSlipView(row({ outlet: null, reservations: [{ outlet: { name: 'Outlet Reserved' } }] } as never)).outlet).toBe('Outlet Reserved');
    expect(toPackingSlipView(row({ outlet: null, reservations: [] })).outlet).toBe('—');
  });

  it('legacy address: fullAddress, no region lines, postal/phone fall back to "—"', () => {
    const view = toPackingSlipView(row({
      address: { recipientName: 'Ani', addressDetail: null, fullAddress: 'Jl. Lama 1, Bandung', phone: '', postalCode: null, province: null, city: null, district: null, village: null },
    } as never));
    expect(view.recipient).toEqual({ name: 'Ani', address: 'Jl. Lama 1, Bandung', regionLines: [], postalCode: '—', phone: '—' });
  });

  it('partial regions render only the ones present; postal code falls back to the village', () => {
    const base = row();
    const view = toPackingSlipView(row({ address: { ...base.address, postalCode: null, district: null, province: null } } as never));
    expect(view.recipient.regionLines).toEqual(['Kel. Kebon Pisang', 'Kota Bandung']);
    expect(view.recipient.postalCode).toBe('40111');
  });

  it('no shipment: "Belum tersedia" and "Belum ada pengiriman"', () => {
    expect(toPackingSlipView(row({ shipment: null })).shipment).toEqual({ trackingNumber: null, awbLabel: AWB_NOT_AVAILABLE, status: null, statusLabel: NO_SHIPMENT });
  });

  it('shipment without AWB keeps its real status; a blank AWB is treated as missing', () => {
    expect(toPackingSlipView(row({ shipment: { trackingNumber: null, status: ShipmentStatus.RATE_SELECTED } })).shipment).toEqual({
      trackingNumber: null, awbLabel: 'Belum tersedia', status: 'RATE_SELECTED', statusLabel: 'Kurir dipilih',
    });
    expect(toPackingSlipView(row({ shipment: { trackingNumber: '  ', status: ShipmentStatus.FAILED } })).shipment.trackingNumber).toBeNull();
  });

  it('the AWB is passed through exactly as stored (no trimming of punctuation or case)', () => {
    const awb = 'JNE/0109401600067399-a';
    expect(toPackingSlipView(row({ shipment: { trackingNumber: awb, status: ShipmentStatus.IN_TRANSIT } })).shipment).toMatchObject({ trackingNumber: awb, awbLabel: awb });
  });

  it('every shipment status has an Indonesian label', () => {
    for (const status of Object.values(ShipmentStatus)) expect(SHIPMENT_STATUS_LABEL_ID[status]).toEqual(expect.any(String));
  });

  it('long strings are passed through untruncated (the document wraps them)', () => {
    const long = 'Baso '.repeat(80).trim();
    const address = 'Jl. '.repeat(120).trim();
    const base = row();
    const view = toPackingSlipView(row({ items: [{ productName: long, quantity: 1, toppings: [] }], address: { ...base.address, addressDetail: address } } as never));
    expect(view.items[0].productName).toBe(long);
    expect(view.recipient.address).toBe(address);
  });
});

describe('the read: narrow select, 404, no writes', () => {
  it('selects only slip fields - no payment, events, notes, user or provider payload', () => {
    const keys = JSON.stringify(PACKING_SLIP_SELECT);
    for (const forbidden of ['payment', 'events', 'notes', 'user', 'providerPayload', 'metadata', 'price', 'totalPrice', 'history']) {
      expect([forbidden, keys.includes(`"${forbidden}"`)]).toEqual([forbidden, false]);
    }
  });

  it('404 for a missing or soft-deleted order; only findUnique is ever called', async () => {
    const order = { findUnique: jest.fn() };
    const service = new PackingSlipService({ order } as never);
    order.findUnique.mockResolvedValueOnce(null);
    await expect(service.get('nope')).rejects.toBeInstanceOf(NotFoundException);
    order.findUnique.mockResolvedValueOnce(row({ deletedAt: new Date() }));
    await expect(service.get('gone')).rejects.toBeInstanceOf(NotFoundException);
    order.findUnique.mockResolvedValueOnce(row());
    await expect(service.get('o1')).resolves.toMatchObject({ orderNumber: 'BMS-20260917-HV5CPKXA' });
    expect(order.findUnique).toHaveBeenLastCalledWith({ where: { id: 'o1' }, select: PACKING_SLIP_SELECT });
    expect(Object.keys(order)).toEqual(['findUnique']);
  });
});

describe('route contract', () => {
  const handler = AdminOperationsController.prototype.packingSlip;

  it('GET orders/:id/packing-slip, Order.read, Cache-Control: no-store', () => {
    expect(Reflect.getMetadata('path', handler)).toBe('orders/:id/packing-slip');
    expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['Order.read']);
    expect(Reflect.getMetadata('__headers__', handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });

  it('is behind the admin session guard and the permission guard (controller level)', () => {
    const guards = Reflect.getMetadata('__guards__', AdminOperationsController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([AdminGuard, PermissionGuard]));
  });

  it('delegates to the packing slip service only', async () => {
    const get = jest.fn().mockResolvedValue({ orderNumber: 'X' });
    const controller = new AdminOperationsController({} as never, {} as never, {} as never, {} as never, {} as never, { get } as never);
    await expect(controller.packingSlip('o1')).resolves.toEqual({ orderNumber: 'X' });
    expect(get).toHaveBeenCalledWith('o1');
  });
});
