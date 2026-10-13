import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';
import { PAXEL_STATUS_LABEL_ID, shipmentDisplayLabel } from '../../src/modules/shipment/shipment-display-label';

describe('ShipmentStatusMapper', () => {
  const mapper = new ShipmentStatusMapper();

  it('maps Paxel statuses to internal statuses', () => {
    expect(mapper.map('paxel', 'BOOKED')).toEqual({ mapped: ShipmentStatus.CREATED, known: true });
    expect(mapper.map('paxel', 'OUT_FOR_DELIVERY').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(mapper.map('paxel', 'DELIVERED').mapped).toBe(ShipmentStatus.DELIVERED);
    expect(mapper.map('paxel', 'CANCELLED').mapped).toBe(ShipmentStatus.CANCELLED);
  });

  /**
   * CCS is Paxel's cancelled state. This is confirmed behaviour, not an acronym
   * guess: against Paxel staging, POST /shipments/:awb/cancel returned 200
   * echoing the cancellation_reason we sent, after which GET /shipments/:awb
   * reported latest_status "CCS" carrying that same reason.
   *
   * Before this mapping, CCS fell through to UNKNOWN - and the sync service
   * never persists UNKNOWN - so a shipment cancelled at Paxel stayed CREATED in
   * our database indefinitely.
   */
  it('maps Paxel CCS to CANCELLED (confirmed against staging)', () => {
    expect(mapper.map('paxel', 'CCS')).toEqual({ mapped: ShipmentStatus.CANCELLED, known: true });
    expect(mapper.toOrderStatus(mapper.map('paxel', 'CCS').mapped)).toBe(OrderStatus.CANCELLED);
  });

  it('FAILED3PL and ONHOLD3PL stay AS-IS: unmapped, UNKNOWN, never read from their literal words', () => {
    const warn = jest.spyOn(mapper['logger'], 'warn').mockImplementation(() => undefined);
    // Paxel has not confirmed their meaning; they must not become FAILED / on-hold / anything.
    for (const code of ['FAILED3PL', 'ONHOLD3PL', 'failed3pl', ' onhold3pl ']) {
      expect(mapper.map('paxel', code)).toEqual({ mapped: ShipmentStatus.UNKNOWN, known: false });
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it.each([
    // Paxel screenshot source of truth -> the existing internal lifecycle.
    ['RTP', ShipmentStatus.CREATED], // Courier is on the way to pickup location
    ['COL', ShipmentStatus.WAITING_PICKUP], // Courier has arrived at pickup location
    ['PAPV', ShipmentStatus.PICKED_UP], // Courier has picked up your shipment
    ['POLXL', ShipmentStatus.IN_TRANSIT], // Package on Origin Locker
    ['ODLXL', ShipmentStatus.IN_TRANSIT], // Package on Destination Locker
    ['HAPH', ShipmentStatus.IN_TRANSIT], // Hold at Paxel Home
    ['COD', ShipmentStatus.OUT_FOR_DELIVERY], // Courier has arrived at destination
    ['ODL', ShipmentStatus.OUT_FOR_DELIVERY], // Existing internal mapping; label uses Paxel code.
    ['PDO', ShipmentStatus.DELIVERED], // Delivery is Completed
    ['PRJL', ShipmentStatus.FAILED], // Pickup cancelled by courier
    ['RAP', ShipmentStatus.FAILED], // Existing internal mapping; label uses Paxel code.
  ])('documented Paxel status %s -> %s', (code, status) => {
    expect(mapper.map('paxel', code)).toEqual({ mapped: status, known: true });
  });

  it('preserves internal mappings while displaying the Paxel-specific description', () => {
    expect(mapper.map('paxel', 'ODL').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(mapper.label(ShipmentStatus.OUT_FOR_DELIVERY, 'paxel', 'ODL')).toBe('Kurir telah tiba di locker tujuan');
    expect(mapper.map('paxel', 'RAP').mapped).toBe(ShipmentStatus.FAILED);
    expect(mapper.label(ShipmentStatus.FAILED, 'paxel', 'RAP')).toBe('Percobaan pickup ulang');
    const delivered = ['RTP', 'COL', 'PAPV', 'POLXL', 'ODLXL', 'COD', 'PDO', 'PRJL', 'HAPH', 'ODL'].filter(
      (code) => mapper.map('paxel', code).mapped === ShipmentStatus.DELIVERED,
    );
    expect(delivered).toEqual(['PDO']);
  });

  it('PRJL (pickup cancelled by courier) is FAILED, not CANCELLED: the customer order is never cancelled by it', () => {
    expect(mapper.map('paxel', 'PRJL').mapped).toBe(ShipmentStatus.FAILED);
    expect(mapper.toOrderStatus(ShipmentStatus.FAILED)).not.toBe(OrderStatus.CANCELLED);
  });

  it('keeps the previously established Paxel mappings unchanged', () => {
    const expected: Array<[string, ShipmentStatus]> = [
      ['CONFIRMED', ShipmentStatus.CREATED],
      // RTP keeps its internal CREATED state; its display meaning is pickup en route.
      ['RTP', ShipmentStatus.CREATED],
      ['COL', ShipmentStatus.WAITING_PICKUP],
      ['PAPV', ShipmentStatus.PICKED_UP],
      ['POL', ShipmentStatus.IN_TRANSIT],
      ['POD', ShipmentStatus.OUT_FOR_DELIVERY],
      ['COD', ShipmentStatus.OUT_FOR_DELIVERY],
      ['PDO', ShipmentStatus.DELIVERED],
      ['PRJL', ShipmentStatus.FAILED],
      ['RAP', ShipmentStatus.FAILED],
      ['UNDLM', ShipmentStatus.FAILED],
      ['RTN', ShipmentStatus.FAILED],
    ];
    for (const [code, status] of expected) {
      expect(mapper.map('paxel', code)).toEqual({ mapped: status, known: true });
    }
  });

  it('uses the supplied Indonesian Paxel labels without exposing internal enum names', () => {
    const expected = {
      RTP: 'Kurir sedang menuju lokasi pickup',
      CONFIRMED: 'Pengiriman dibuat',
      COL: 'Kurir telah tiba di lokasi pickup',
      PRJL: 'Pickup dibatalkan oleh kurir',
      RAP: 'Percobaan pickup ulang',
      PAPV: 'Kurir telah mengambil paket Anda',
      POL: 'Paket sedang dalam perjalanan',
      POLXL: 'Paket berada di locker asal',
      ODL: 'Kurir telah tiba di locker tujuan',
      ODLXL: 'Paket berada di locker tujuan',
      POD: 'Kurir sedang menuju tujuan',
      COD: 'Kurir telah tiba di tujuan',
      PDO: 'Pengiriman telah selesai',
      UNDLM: 'Pengiriman tidak berhasil dikirim',
      HAPH: 'Paket ditahan di Paxel Home',
      RTN: 'Paket dikembalikan',
      FAILED3PL: 'Kurir tidak ditemukan',
      CCS: 'Pengiriman dibatalkan',
      ONHOLD3PL: 'Paket ditahan',
    } satisfies Record<keyof typeof PAXEL_STATUS_LABEL_ID, string>;

    expect(PAXEL_STATUS_LABEL_ID).toEqual(expected);
    for (const [code, label] of Object.entries(expected)) {
      expect(shipmentDisplayLabel('paxel', ShipmentStatus.UNKNOWN, code)).toBe(label);
    }
    expect(shipmentDisplayLabel('paxel', ShipmentStatus.IN_TRANSIT, 'NEW_CODE')).toBe('Dalam perjalanan');
  });

  it('uses the raw Paxel code for notification labels while preserving other-provider labels', () => {
    expect(mapper.label(ShipmentStatus.FAILED, 'paxel', 'PRJL')).toBe('Pickup dibatalkan oleh kurir');
    expect(mapper.label(ShipmentStatus.OUT_FOR_DELIVERY, 'paxel', 'COD')).toBe('Kurir telah tiba di tujuan');
    expect(mapper.label(ShipmentStatus.OUT_FOR_DELIVERY, 'jne', 'OUT_FOR_DELIVERY')).toBe('sedang menuju alamat Anda');
  });

  it('maps JNE statuses (with spaces/case) to internal statuses', () => {
    expect(mapper.map('jne', 'on process').mapped).toBe(ShipmentStatus.IN_TRANSIT);
    expect(mapper.map('jne', 'With Delivery Courier').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
    expect(mapper.map('jne', 'DELIVERED').mapped).toBe(ShipmentStatus.DELIVERED);
  });

  it('returns UNKNOWN (and logs) for unrecognized statuses', () => {
    const warn = jest.spyOn(mapper['logger'], 'warn').mockImplementation(() => undefined);
    const result = mapper.map('jne', 'SOMETHING_WEIRD');
    expect(result).toEqual({ mapped: ShipmentStatus.UNKNOWN, known: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('derives the order status and notify flag from the mapped status', () => {
    expect(mapper.toOrderStatus(ShipmentStatus.IN_TRANSIT)).toBe(OrderStatus.DELIVERING);
    expect(mapper.toOrderStatus(ShipmentStatus.DELIVERED)).toBe(OrderStatus.DELIVERED);
    expect(mapper.toOrderStatus(ShipmentStatus.CANCELLED)).toBe(OrderStatus.CANCELLED);
    expect(mapper.toOrderStatus(ShipmentStatus.FAILED)).toBeNull();
    expect(mapper.shouldNotify(ShipmentStatus.PICKED_UP)).toBe(true);
    expect(mapper.shouldNotify(ShipmentStatus.WAITING_PICKUP)).toBe(false);
  });
});
