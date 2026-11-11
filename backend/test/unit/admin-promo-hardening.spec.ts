import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminService } from '../../src/modules/admin/admin.service';
import { CreatePromoDto } from '../../src/modules/admin/application/dto/create-promo.dto';
import { UpdatePromoDto } from '../../src/modules/admin/application/dto/update-promo.dto';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Phase 4N.12 — promo configuration hardening.
 *
 * C. A cap of 0 on an active discount component is refused (DTO, service and the
 *    checkout availability gate); null stays "no cap"; a positive cap is accepted.
 * D. Direct admin PATCH: switching configuration clears the columns the new
 *    configuration no longer reads, keeps explicit null-clearing, and never
 *    touches unrelated columns.
 */

const existingPromo = (overrides: Record<string, any> = {}) => ({
  id: 'promo-1',
  code: 'BASE',
  title: 'Base',
  description: 'Base promo',
  voucherType: 'PERCENTAGE_DISCOUNT',
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
  minimumOrderAmount: 25000,
  maxUsageCount: 50,
  currentUsageCount: 7,
  isNewUserOnly: true,
  startDate: new Date('2026-11-01T00:00:00Z'),
  endDate: new Date('2026-12-01T00:00:00Z'),
  isActive: true,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const UNRELATED_COLUMNS = [
  'code',
  'title',
  'description',
  'minimumOrderAmount',
  'maxUsageCount',
  'currentUsageCount',
  'isNewUserOnly',
  'startDate',
  'endDate',
  'isActive',
];

describe('Promo configuration hardening (Phase 4N.12)', () => {
  let prisma: any;
  let service: AdminService;

  beforeEach(() => {
    prisma = {
      promo: {
        create: jest.fn(async ({ data }: any) => ({ id: 'promo-new', ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        findUnique: jest.fn(async () => existingPromo()),
      },
    };
    service = new AdminService(prisma as never, {} as never);
  });

  const patchData = () => prisma.promo.update.mock.calls[0][0].data;
  const dtoErrors = async (cls: any, body: Record<string, any>) => validate(plainToInstance(cls, body));

  describe('C. zero discount cap', () => {
    const createBase = { code: 'CAP', title: 'Cap', description: 'desc', voucherType: 'PERCENTAGE_DISCOUNT' };
    const product = { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 };
    const shipping = { shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne'] };

    describe('DTO', () => {
      it.each([CreatePromoDto, UpdatePromoDto])('%p rejects product cap = 0', async (cls) => {
        const errors = await dtoErrors(cls, { ...createBase, ...product, productMaxDiscountAmount: 0 });
        expect(errors.map((e) => e.property)).toContain('productMaxDiscountAmount');
      });

      it.each([CreatePromoDto, UpdatePromoDto])('%p rejects shipping cap = 0', async (cls) => {
        const errors = await dtoErrors(cls, { ...createBase, ...shipping, shippingMaxDiscountAmount: 0 });
        expect(errors.map((e) => e.property)).toContain('shippingMaxDiscountAmount');
      });

      it.each([CreatePromoDto, UpdatePromoDto])('%p accepts null caps (no cap)', async (cls) => {
        const errors = await dtoErrors(cls, {
          ...createBase,
          ...product,
          ...shipping,
          productMaxDiscountAmount: null,
          shippingMaxDiscountAmount: null,
        });
        expect(errors).toHaveLength(0);
      });

      it.each([CreatePromoDto, UpdatePromoDto])('%p accepts positive caps', async (cls) => {
        const errors = await dtoErrors(cls, {
          ...createBase,
          ...product,
          ...shipping,
          productMaxDiscountAmount: 1,
          shippingMaxDiscountAmount: 15000,
        });
        expect(errors).toHaveLength(0);
      });

      it('legacy caps keep their existing rule (0 still allowed: unchanged)', async () => {
        const errors = await dtoErrors(CreatePromoDto, { ...createBase, discountPercentage: 10, maxDiscountAmount: 0 });
        expect(errors).toHaveLength(0);
      });
    });

    describe('AdminService', () => {
      it('createPromo rejects product cap = 0', async () => {
        await expect(service.createPromo({ ...createBase, ...product, productMaxDiscountAmount: 0 } as any)).rejects.toThrow(
          'Product discount cap must be at least Rp1, or left empty for no cap',
        );
        expect(prisma.promo.create).not.toHaveBeenCalled();
      });

      it('createPromo rejects shipping cap = 0', async () => {
        await expect(service.createPromo({ ...createBase, ...shipping, shippingMaxDiscountAmount: 0 } as any)).rejects.toThrow(
          'Shipping discount cap must be at least Rp1, or left empty for no cap',
        );
        expect(prisma.promo.create).not.toHaveBeenCalled();
      });

      it('updatePromo rejects a zero cap on a component that is already stored', async () => {
        prisma.promo.findUnique.mockResolvedValue(existingPromo(shipping));
        await expect(service.updatePromo('promo-1', { shippingMaxDiscountAmount: 0 } as any)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(prisma.promo.update).not.toHaveBeenCalled();
      });

      it('accepts null and positive caps', async () => {
        await service.createPromo({ ...createBase, ...product, productMaxDiscountAmount: null } as any);
        await service.createPromo({ ...createBase, ...shipping, shippingMaxDiscountAmount: 8000 } as any);
        expect(prisma.promo.create).toHaveBeenCalledTimes(2);
      });
    });

    describe('checkout availability gate', () => {
      const orders = () =>
        new OrdersService(
          { order: { count: jest.fn().mockResolvedValue(0) }, voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) } } as any,
          {} as any,
          {} as any,
          {} as any,
        );
      const gate = (voucher: any) =>
        (orders() as any).assertVoucherAvailability(
          { ...existingPromo({ isNewUserOnly: false, startDate: null, endDate: null, minimumOrderAmount: 0, currentUsageCount: 0 }), ...voucher },
          'user-1',
          100000,
        );

      it('refuses a stored zero product / shipping cap, accepts null and positive', async () => {
        await expect(gate({ ...product, productMaxDiscountAmount: 0 })).rejects.toThrow('Voucher configuration is invalid');
        await expect(gate({ ...shipping, shippingMaxDiscountAmount: 0 })).rejects.toThrow('Voucher configuration is invalid');
        await expect(gate({ ...product, productMaxDiscountAmount: null })).resolves.toBeUndefined();
        await expect(gate({ ...shipping, shippingMaxDiscountAmount: 5000 })).resolves.toBeUndefined();
      });
    });
  });

  describe('D. admin PATCH configuration switching', () => {
    it('legacy -> component clears the inert legacy columns', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 15, maxDiscountAmount: 20000 }),
      );
      await service.updatePromo('promo-1', {
        productDiscountType: 'FIXED',
        productDiscountAmount: 9000,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      } as any);
      const data = patchData();
      expect(data).toMatchObject({
        productDiscountType: 'FIXED',
        productDiscountAmount: 9000,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
        discountPercentage: null,
        maxDiscountAmount: null,
      });
      // Already-null legacy columns are not rewritten; voucherType is never touched.
      expect(data).not.toHaveProperty('discountAmount');
      expect(data).not.toHaveProperty('freeShippingMaxAmount');
      expect(data).not.toHaveProperty('voucherType');
    });

    it('legacy FREE_SHIPPING -> product-only component clears its cap and its courier restriction', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ voucherType: 'FREE_SHIPPING', freeShippingMaxAmount: 15000, eligibleCouriers: ['paxel'] }),
      );
      await service.updatePromo('promo-1', { productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 } as any);
      const data = patchData();
      expect(data.freeShippingMaxAmount).toBeNull();
      expect(data.eligibleCouriers).toBeNull();
    });

    it('component -> legacy clears the obsolete component columns', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'PERCENTAGE',
          productDiscountPercentage: 10,
          productMaxDiscountAmount: 20000,
          shippingDiscountType: 'FIXED',
          shippingDiscountAmount: 5000,
          shippingMaxDiscountAmount: 5000,
          eligibleCouriers: ['jne'],
        }),
      );
      await service.updatePromo('promo-1', {
        voucherType: 'FIXED_DISCOUNT',
        discountAmount: 8000,
        productDiscountType: null,
        shippingDiscountType: null,
      } as any);
      const data = patchData();
      expect(data).toMatchObject({
        voucherType: 'FIXED_DISCOUNT',
        discountAmount: 8000,
        productDiscountType: null,
        productDiscountPercentage: null,
        productDiscountAmount: null,
        productMaxDiscountAmount: null,
        shippingDiscountType: null,
        shippingDiscountPercentage: null,
        shippingDiscountAmount: null,
        shippingMaxDiscountAmount: null,
        eligibleCouriers: null,
      });
    });

    it('component -> legacy FREE_SHIPPING keeps an explicitly supplied courier restriction', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] }),
      );
      await service.updatePromo('promo-1', {
        voucherType: 'FREE_SHIPPING',
        shippingDiscountType: null,
        eligibleCouriers: ['paxel'],
      } as any);
      const data = patchData();
      expect(data.shippingDiscountType).toBeNull();
      expect(data.eligibleCouriers).toEqual(['paxel']);
    });

    it('re-saving a legacy FREE_SHIPPING voucher keeps its courier restriction', async () => {
      // The admin form always sends shippingDiscountType: null for a legacy voucher;
      // there is no shipping component being removed, so the live legacy courier
      // restriction must survive.
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ voucherType: 'FREE_SHIPPING', freeShippingMaxAmount: 15000, eligibleCouriers: ['jne'] }),
      );
      await service.updatePromo('promo-1', {
        voucherType: 'FREE_SHIPPING',
        freeShippingMaxAmount: 12000,
        productDiscountType: null,
        shippingDiscountType: null,
      } as any);
      const data = patchData();
      expect(data.freeShippingMaxAmount).toBe(12000);
      expect(data).not.toHaveProperty('eligibleCouriers');
    });

    it('switching a component type clears the value the new type does not read', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          shippingDiscountType: 'PERCENTAGE',
          shippingDiscountPercentage: 50,
          shippingMaxDiscountAmount: 8000,
          eligibleCouriers: ['jne'],
        }),
      );
      await service.updatePromo('promo-1', { shippingDiscountType: 'FREE_SHIPPING' } as any);
      const data = patchData();
      expect(data.shippingDiscountType).toBe('FREE_SHIPPING');
      expect(data.shippingDiscountPercentage).toBeNull();
      // Still read by FREE_SHIPPING: kept.
      expect(data).not.toHaveProperty('shippingMaxDiscountAmount');
      expect(data).not.toHaveProperty('eligibleCouriers');
    });

    it('switching legacy type clears the previous type column', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10, maxDiscountAmount: 5000 }),
      );
      await service.updatePromo('promo-1', { voucherType: 'FIXED_DISCOUNT', discountAmount: 5000 } as any);
      const data = patchData();
      expect(data).toMatchObject({ voucherType: 'FIXED_DISCOUNT', discountAmount: 5000, discountPercentage: null, maxDiscountAmount: null });
    });

    it('unrelated columns are never written by a configuration switch', async () => {
      prisma.promo.findUnique.mockResolvedValue(existingPromo({ discountPercentage: 10 }));
      await service.updatePromo('promo-1', { productDiscountType: 'FIXED', productDiscountAmount: 3000 } as any);
      const data = patchData();
      for (const column of UNRELATED_COLUMNS) expect(data).not.toHaveProperty(column);
    });

    it('a PATCH that does not touch configuration does not clear stale configuration', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({ discountPercentage: 25, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 }),
      );
      await service.updatePromo('promo-1', { title: 'Renamed', isActive: false } as any);
      expect(patchData()).toEqual({ title: 'Renamed', isActive: false });
    });

    it('explicit null-clearing still clears exactly the named component group', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'FIXED',
          productDiscountAmount: 7000,
          shippingDiscountType: 'PERCENTAGE',
          shippingDiscountPercentage: 20,
          eligibleCouriers: ['paxel'],
        }),
      );
      await service.updatePromo('promo-1', { productDiscountType: null } as any);
      const data = patchData();
      expect(data).toEqual({
        productDiscountType: null,
        productDiscountPercentage: null,
        productDiscountAmount: null,
        productMaxDiscountAmount: null,
      });
    });

    it('explicit null on a nullable unrelated column is still written', async () => {
      await service.updatePromo('promo-1', { maxUsageCount: null, startDate: null } as any);
      expect(patchData()).toEqual({ maxUsageCount: null, startDate: null });
    });
  });
});
