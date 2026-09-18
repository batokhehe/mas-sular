import { OrderStatus, ShipmentStatus } from '@prisma/client';
import { ShipmentStatusMapper } from '../../src/modules/shipment/shipment-status.mapper';

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
    // Paxel documentation (Webhook > Shipment Status Mapping) -> the existing lifecycle.
    ['RTP', ShipmentStatus.CREATED], // Shipment successfully created
    ['COL', ShipmentStatus.WAITING_PICKUP], // Courier has arrived at pickup location
    ['PAPV', ShipmentStatus.PICKED_UP], // Courier has picked up your shipment
    ['POLXL', ShipmentStatus.IN_TRANSIT], // Package on Origin Locker
    ['ODLXL', ShipmentStatus.IN_TRANSIT], // Package on Destination Locker
    ['HAPH', ShipmentStatus.IN_TRANSIT], // Hold at Paxel Home
    ['COD', ShipmentStatus.OUT_FOR_DELIVERY], // Courier has arrived at destination
    ['ODL', ShipmentStatus.OUT_FOR_DELIVERY], // On Delivery
    ['PDO', ShipmentStatus.DELIVERED], // Delivery is Completed
    ['PRJL', ShipmentStatus.FAILED], // Pickup cancelled by courier
  ])('documented Paxel status %s -> %s', (code, status) => {
    expect(mapper.map('paxel', code)).toEqual({ mapped: status, known: true });
  });

  it('ODL is "On Delivery": OUT_FOR_DELIVERY, never DELIVERED; only PDO completes a delivery', () => {
    expect(mapper.map('paxel', 'ODL').mapped).toBe(ShipmentStatus.OUT_FOR_DELIVERY);
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
      // RTP: CREATED since Paxel documented it as "Shipment successfully created".
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
