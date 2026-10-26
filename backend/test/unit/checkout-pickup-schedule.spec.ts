import { OrdersService } from '../../src/modules/orders/orders.service';
import { PickupScheduleService } from '../../src/modules/shipping/pickup-schedule.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { DEFAULT_PICKUP_POLICY, ShippingConfig } from '../../src/modules/shipping/shipping.config';

/**
 * /checkout/shipping-options carries the shop pickup schedule (Phase 2).
 *
 * The response stays an ARRAY of options (backward compatible); each option gains
 * an optional `pickupSchedule` resolved by the same rule the courier is booked
 * with, evaluated at quote time. The quote itself - price, service, courier ETA -
 * is untouched: the pickup schedule is never presented as a delivery estimate.
 */

const USER = 'user-1';
const PRODUCT = { id: 'p1', name: 'Keju', price: 45000, stock: 10, status: 'ACTIVE', deletedAt: null, weightGram: 200 };

const OUTLET = {
  id: 'outlet-1',
  name: 'Pusat',
  postalCode: '40111',
  latitude: -6.9147,
  longitude: 107.6098,
  addressDetail: 'Jl. Outlet No.1',
  province: { name: 'Jawa Barat' },
  city: { name: 'Kota Bandung' },
  district: { name: 'Coblong' },
  village: { name: 'Dago' },
};

const ADDRESS = {
  id: 'addr-1',
  userId: USER,
  deletedAt: null,
  provinceId: 'prov-1',
  cityId: 'city-1',
  districtId: 'dist-1',
  villageId: 'vill-1',
  postalCode: '40562',
  latitude: -6.87,
  longitude: 107.61,
  fullAddress: 'Jl. Pelanggan No.7',
  addressDetail: 'Blok C',
  province: { name: 'Jawa Barat' },
  city: { name: 'Kabupaten Bandung Barat' },
  district: { name: 'Cihampelas' },
  village: { name: 'Pataruman' },
};

const QUOTES = [
  { provider: 'jne', service: 'REG', serviceName: 'JNE Reguler', estimatedDays: '1-2 Days', shippingCost: 9000 },
  { provider: 'paxel', service: 'PAXEL_SAMEDAY', serviceName: 'Paxel Same Day', estimatedDays: 'Today', shippingCost: 78000 },
];

function build(pickupSchedule?: PickupScheduleService) {
  const courier = { name: 'multi', getRates: jest.fn(async () => QUOTES.map((q) => ({ ...q }))) };
  const shipping = new ShippingService({ getAll: () => [courier] } as never);
  const prisma = {
    address: { findFirst: jest.fn().mockResolvedValue(ADDRESS) },
    product: { findMany: jest.fn().mockResolvedValue([PRODUCT]) },
    topping: { findMany: jest.fn().mockResolvedValue([]) },
    outlet: { findFirst: jest.fn().mockResolvedValue(OUTLET) },
    promo: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const allocation = {
    allocate: jest.fn(async () => ({
      outletId: OUTLET.id,
      outlet: { ...OUTLET, address: OUTLET.addressDetail },
      quotes: await shipping.getQuotes({} as never),
    })),
  };
  // Positional, like every other OrdersService spec: pickupSchedule is the LAST
  // optional dependency, after uniqueCode, paymentInitiation, paymentChannels, feeConfig.
  const service = new OrdersService(
    prisma as never,
    shipping as never,
    { isCheckoutEnabled: () => false } as never,
    { issue: jest.fn() } as never,
    undefined,
    undefined,
    allocation as never,
    undefined,
    undefined,
    undefined,
    undefined,
    pickupSchedule,
  );
  return service;
}

const dto = { address_id: 'addr-1', items: [{ product_id: 'p1', qty: 1 }] } as never;
const defaultSchedule = () =>
  new PickupScheduleService({ pickupPolicy: DEFAULT_PICKUP_POLICY } as unknown as ShippingConfig);

/** Freeze the wall clock only: promises and timers keep running normally. */
function at(iso: string) {
  jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
}

afterEach(() => jest.useRealTimers());

describe('every option carries the same pickupSchedule', () => {
  it('Friday 15:30 WIB: Monday 17:00, reason MONDAY_AFTER_FRIDAY_CUTOFF, with the policy that produced it', async () => {
    at('2026-11-06T15:30:00+07:00');
    const options = await build(defaultSchedule()).getShippingOptions(USER, dto);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.pickupSchedule).toEqual({
        pickupAt: '2026-11-09T10:00:00.000Z',
        reason: 'MONDAY_AFTER_FRIDAY_CUTOFF',
        referenceAt: '2026-11-06T08:30:00.000Z',
        timeZone: 'Asia/Jakarta',
        cutoffTime: '15:00',
        pickupTime: '17:00',
      });
    }
  });

  it('Saturday: Monday, reason MONDAY_AFTER_WEEKEND', async () => {
    at('2026-11-07T10:00:00+07:00');
    const [option] = await build(defaultSchedule()).getShippingOptions(USER, dto);
    expect(option.pickupSchedule).toMatchObject({ pickupAt: '2026-11-09T10:00:00.000Z', reason: 'MONDAY_AFTER_WEEKEND' });
  });

  it('Sunday 23:59: Monday, reason MONDAY_AFTER_WEEKEND', async () => {
    at('2026-11-08T23:59:00+07:00');
    const [option] = await build(defaultSchedule()).getShippingOptions(USER, dto);
    expect(option.pickupSchedule?.reason).toBe('MONDAY_AFTER_WEEKEND');
  });

  it('Tuesday 10:00: same day, reason SAME_DAY', async () => {
    at('2026-11-03T10:00:00+07:00');
    const [option] = await build(defaultSchedule()).getShippingOptions(USER, dto);
    expect(option.pickupSchedule).toMatchObject({ pickupAt: '2026-11-03T10:00:00.000Z', reason: 'SAME_DAY' });
  });

  it('follows the configured policy, not a copy of it', async () => {
    at('2026-11-06T14:30:00+07:00');
    const custom = new PickupScheduleService({
      pickupPolicy: { timeZone: 'Asia/Jakarta', cutoffTime: '14:00', pickupTime: '17:00' },
    } as unknown as ShippingConfig);
    const [option] = await build(custom).getShippingOptions(USER, dto);
    expect(option.pickupSchedule).toMatchObject({ reason: 'MONDAY_AFTER_FRIDAY_CUTOFF', cutoffTime: '14:00' });
  });
});

describe('the quote itself is untouched', () => {
  it('price, service and the courier ETA are exactly what the courier returned', async () => {
    at('2026-11-06T15:30:00+07:00');
    const options = await build(defaultSchedule()).getShippingOptions(USER, dto);
    expect(options.map(({ pickupSchedule, ...quote }) => quote)).toEqual(QUOTES);
  });

  it('survives JSON serialisation as plain strings', async () => {
    at('2026-11-07T10:00:00+07:00');
    const [option] = JSON.parse(JSON.stringify(await build(defaultSchedule()).getShippingOptions(USER, dto)));
    expect(typeof option.pickupSchedule.pickupAt).toBe('string');
    expect(option.estimatedDays).toBe('1-2 Days');
  });
});

describe('backward compatibility', () => {
  it('without the schedule service the response is exactly the previous array of quotes', async () => {
    const options = await build(undefined).getShippingOptions(USER, dto);
    expect(options).toEqual(QUOTES);
    expect(options[0]).not.toHaveProperty('pickupSchedule');
  });

  it('the schedule service falls back to the business default when no config is injected', () => {
    const schedule = new PickupScheduleService(undefined).forReference(new Date('2026-11-06T08:00:00Z'));
    expect(schedule).toMatchObject({ reason: 'MONDAY_AFTER_FRIDAY_CUTOFF', cutoffTime: '15:00', pickupTime: '17:00' });
  });
});
