import { BadRequestException } from '@nestjs/common';
import { Prisma, VoucherType } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Legacy FREE_SHIPPING courier eligibility (smoke-test finding 1, 2026-11-20).
 *
 * A legacy "Gratis ongkir" voucher's eligibleCouriers is its live checkout
 * restriction. Every NEW free-shipping configuration must name a courier; an
 * existing one stored without couriers (it applies to every courier) stays
 * editable for unrelated fields; switching away clears the list as SQL NULL.
 */

const legacyPromo = (overrides: Record<string, unknown> = {}) => ({
  id: 'promo-1',
  code: 'ONGKIR',
  title: 'Gratis ongkir',
  description: 'desc',
  voucherType: 'FREE_SHIPPING',
  discountPercentage: null,
  discountAmount: null,
  maxDiscountAmount: null,
  freeShippingMaxAmount: null,
  productDiscountType: null,
  productDiscountPercentage: null,
  productDiscountAmount: null,
  productMaxDiscountAmount: null,
  shippingDiscountType: null,
  shippingDiscountPercentage: null,
  shippingDiscountAmount: null,
  shippingMaxDiscountAmount: null,
  eligibleCouriers: null,
  minimumOrderAmount: null,
  maxUsageCount: null,
  currentUsageCount: 0,
  isNewUserOnly: false,
  startDate: null,
  endDate: null,
  isActive: true,
  deletedAt: null,
  ...overrides,
});

function build(existing = legacyPromo()) {
  const prisma = {
    promo: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'promo-new', ...data })),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
      findUnique: jest.fn(async () => existing),
    },
  };
  return { prisma, service: new AdminService(prisma as never, {} as never) };
}

const createDto = (overrides: Record<string, unknown> = {}) =>
  ({ code: 'ONGKIR', title: 'Gratis ongkir', description: 'desc', voucherType: 'FREE_SHIPPING', ...overrides }) as never;

describe('createPromo: legacy FREE_SHIPPING', () => {
  it('is rejected without a courier (absent, empty or null)', async () => {
    for (const eligibleCouriers of [undefined, [], null]) {
      const { service, prisma } = build();
      await expect(service.createPromo(createDto({ eligibleCouriers }))).rejects.toThrow(
        'eligibleCouriers must contain at least one courier for free shipping vouchers',
      );
      expect(prisma.promo.create).not.toHaveBeenCalled();
    }
  });

  it('accepts Paxel only, JNE only and both, and stores exactly that list', async () => {
    for (const eligibleCouriers of [['paxel'], ['jne'], ['paxel', 'jne']]) {
      const { service, prisma } = build();
      await service.createPromo(createDto({ eligibleCouriers }));
      expect(prisma.promo.create.mock.calls[0][0].data.eligibleCouriers).toEqual(eligibleCouriers);
    }
  });

  it('refuses unsupported or duplicate couriers (the DTO does not check legacy lists)', async () => {
    for (const eligibleCouriers of [['dhl'], ['paxel', 'PAXEL']]) {
      const { service } = build();
      await expect(service.createPromo(createDto({ eligibleCouriers }))).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('other legacy types still need no courier', async () => {
    const { service, prisma } = build();
    await service.createPromo(createDto({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10 }));
    expect(prisma.promo.create).toHaveBeenCalledTimes(1);
  });
});

describe('updatePromo: legacy FREE_SHIPPING', () => {
  it('grandfathered (stored without couriers): unrelated edits stay valid and leave the couriers alone', async () => {
    for (const dto of [{ title: 'Judul baru' }, { isActive: false }, { freeShippingMaxAmount: 15000 }]) {
      const { service, prisma } = build();
      await expect(service.updatePromo('promo-1', dto as never)).resolves.toBeDefined();
      expect('eligibleCouriers' in prisma.promo.update.mock.calls[0][0].data).toBe(false);
    }
  });

  it('grandfathered: choosing couriers later is accepted; explicitly emptying them is not', async () => {
    const ok = build();
    await ok.service.updatePromo('promo-1', { eligibleCouriers: ['jne'] } as never);
    expect(ok.prisma.promo.update.mock.calls[0][0].data.eligibleCouriers).toEqual(['jne']);

    for (const eligibleCouriers of [[], null]) {
      const bad = build();
      await expect(bad.service.updatePromo('promo-1', { eligibleCouriers } as never)).rejects.toBeInstanceOf(BadRequestException);
      expect(bad.prisma.promo.update).not.toHaveBeenCalled();
    }
  });

  it('switching another voucher TO free shipping requires a courier', async () => {
    const percentage = legacyPromo({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10 });
    const { service, prisma } = build(percentage);
    await expect(service.updatePromo('promo-1', { voucherType: 'FREE_SHIPPING' } as never)).rejects.toThrow(
      'eligibleCouriers must contain at least one courier for free shipping vouchers',
    );
    expect(prisma.promo.update).not.toHaveBeenCalled();

    const fixed = build(percentage);
    await fixed.service.updatePromo('promo-1', { voucherType: 'FREE_SHIPPING', eligibleCouriers: ['paxel'] } as never);
    expect(fixed.prisma.promo.update.mock.calls[0][0].data.eligibleCouriers).toEqual(['paxel']);
  });

  it('a voucher with stored couriers keeps them across unrelated edits', async () => {
    const { service, prisma } = build(legacyPromo({ eligibleCouriers: ['jne'] }));
    await service.updatePromo('promo-1', { title: 'x' } as never);
    expect('eligibleCouriers' in prisma.promo.update.mock.calls[0][0].data).toBe(false);
  });

  it('switching away from free shipping with eligibleCouriers: null writes SQL NULL (Prisma.DbNull)', async () => {
    const { service, prisma } = build(legacyPromo({ eligibleCouriers: ['paxel', 'jne'] }));
    await service.updatePromo('promo-1', { voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, eligibleCouriers: null } as never);
    expect(prisma.promo.update.mock.calls[0][0].data.eligibleCouriers).toBe(Prisma.DbNull);
  });

  it('the inert-field rule clears couriers as SQL NULL too (shipping component removed for a product one)', async () => {
    const component = legacyPromo({ voucherType: 'PERCENTAGE_DISCOUNT', shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] });
    const { service, prisma } = build(component);
    await service.updatePromo('promo-1', { shippingDiscountType: null, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 } as never);
    expect(prisma.promo.update.mock.calls[0][0].data.eligibleCouriers).toBe(Prisma.DbNull);
  });
});

describe('checkout eligibility is unchanged', () => {
  const orders = new OrdersService({} as never, {} as never, {} as never, {} as never);
  const shippingFor = (voucher: Record<string, unknown>, provider?: string) =>
    orders.calculateVoucherDiscountBreakdown(
      { voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: null, productDiscountType: null, shippingDiscountType: null, ...voucher } as never,
      100000,
      10000,
      provider,
    ).shippingDiscountAmount;

  it('a legacy free-shipping voucher with couriers discounts only those couriers', () => {
    expect(shippingFor({ eligibleCouriers: ['paxel'] }, 'paxel')).toBe(10000);
    expect(shippingFor({ eligibleCouriers: ['paxel'] }, 'jne')).toBe(0);
    expect(shippingFor({ eligibleCouriers: ['paxel', 'jne'] }, 'jne')).toBe(10000);
  });

  it('a grandfathered one without couriers still applies to every courier', () => {
    expect(shippingFor({ eligibleCouriers: null }, 'jne')).toBe(10000);
    expect(shippingFor({ eligibleCouriers: null }, 'paxel')).toBe(10000);
  });
});
