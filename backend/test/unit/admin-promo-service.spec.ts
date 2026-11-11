import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from '../../src/modules/admin/admin.service';

describe('AdminService promo create/update (Phase 4G.1)', () => {
  let prisma: any;
  let service: AdminService;

  const existingPromo = (overrides: Record<string, any> = {}) => ({
    id: 'promo-1',
    code: 'BASE',
    title: 'Base',
    description: 'Base promo',
    voucherType: 'PERCENTAGE_DISCOUNT',
    discountPercentage: 10,
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
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      promo: {
        create: jest.fn(async ({ data }: any) => ({ id: 'promo-new', ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        findUnique: jest.fn(async () => existingPromo()),
        findMany: jest.fn(async () => []),
      },
    };
    service = new AdminService(prisma as never, {} as never);
  });

  describe('createPromo', () => {
    it('creates product-only percentage promo', async () => {
      const dto: any = {
        code: 'PROD10',
        title: 'Product 10%',
        description: 'desc',
        voucherType: 'PERCENTAGE_DISCOUNT',
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
      };
      const result = await service.createPromo(dto);
      expect(prisma.promo.create).toHaveBeenCalledTimes(1);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.code).toBe('PROD10');
      expect(data.productDiscountType).toBe('PERCENTAGE');
      expect(data.productDiscountPercentage).toBe(10);
      expect(data.startDate).toBeNull();
      expect(data.endDate).toBeNull();
      expect(result.id).toBe('promo-new');
    });

    it('creates product-only fixed promo', async () => {
      const dto: any = {
        code: 'PRODFIX',
        title: 'Product Fixed',
        description: 'desc',
        voucherType: 'FIXED_DISCOUNT',
        productDiscountType: 'FIXED',
        productDiscountAmount: 5000,
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.productDiscountType).toBe('FIXED');
      expect(data.productDiscountAmount).toBe(5000);
    });

    it('creates shipping-only percentage promo', async () => {
      const dto: any = {
        code: 'SHIP10',
        title: 'Ship 10%',
        description: 'desc',
        voucherType: 'PERCENTAGE_DISCOUNT',
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 10,
        eligibleCouriers: ['paxel'],
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.shippingDiscountType).toBe('PERCENTAGE');
      expect(data.shippingDiscountPercentage).toBe(10);
      expect(data.eligibleCouriers).toEqual(['paxel']);
    });

    it('creates shipping-only fixed promo', async () => {
      const dto: any = {
        code: 'SHIPFIX',
        title: 'Ship Fixed',
        description: 'desc',
        voucherType: 'FIXED_DISCOUNT',
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 8000,
        eligibleCouriers: ['jne'],
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.shippingDiscountType).toBe('FIXED');
      expect(data.shippingDiscountAmount).toBe(8000);
      expect(data.eligibleCouriers).toEqual(['jne']);
    });

    it('creates free-shipping promo', async () => {
      const dto: any = {
        code: 'FREESHIP',
        title: 'Free Ship',
        description: 'desc',
        voucherType: 'FREE_SHIPPING',
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['paxel', 'jne'],
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.shippingDiscountType).toBe('FREE_SHIPPING');
      expect(data.eligibleCouriers).toEqual(['paxel', 'jne']);
    });

    it('creates combined product + shipping promo', async () => {
      const dto: any = {
        code: 'COMBO',
        title: 'Combo',
        description: 'desc',
        voucherType: 'PERCENTAGE_DISCOUNT',
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 5000,
        eligibleCouriers: ['paxel'],
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.productDiscountType).toBe('PERCENTAGE');
      expect(data.productDiscountPercentage).toBe(10);
      expect(data.shippingDiscountType).toBe('FIXED');
      expect(data.shippingDiscountAmount).toBe(5000);
      expect(data.eligibleCouriers).toEqual(['paxel']);
    });

    it('rejects shipping promo without eligible couriers', async () => {
      const dto: any = {
        code: 'BADSHIP',
        title: 'Bad',
        description: 'desc',
        voucherType: 'FREE_SHIPPING',
        shippingDiscountType: 'FREE_SHIPPING',
      };
      await expect(service.createPromo(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.promo.create).not.toHaveBeenCalled();
    });

    it('rejects unsupported courier', async () => {
      const dto: any = {
        code: 'BADSHIP',
        title: 'Bad',
        description: 'desc',
        voucherType: 'FREE_SHIPPING',
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['grab'],
      };
      await expect(service.createPromo(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.promo.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate couriers', async () => {
      const dto: any = {
        code: 'BADSHIP',
        title: 'Bad',
        description: 'desc',
        voucherType: 'FREE_SHIPPING',
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['paxel', 'paxel'],
      };
      await expect(service.createPromo(dto)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.promo.create).not.toHaveBeenCalled();
    });

    it('preserves legacy promo creation behavior (no component types)', async () => {
      const dto: any = {
        code: 'LEGACY10',
        title: 'Legacy',
        description: 'desc',
        voucherType: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 10,
      };
      await service.createPromo(dto);
      const data = prisma.promo.create.mock.calls[0][0].data;
      expect(data.voucherType).toBe('PERCENTAGE_DISCOUNT');
      expect(data.discountPercentage).toBe(10);
      expect(data.productDiscountType).toBeUndefined();
      expect(data.shippingDiscountType).toBeUndefined();
    });
  });

  describe('updatePromo', () => {
    it('throws NotFound for missing/deleted promo and does not update', async () => {
      prisma.promo.findUnique.mockResolvedValue(null);
      await expect(service.updatePromo('missing', { title: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.promo.update).not.toHaveBeenCalled();
    });

    it('sparse update preserves existing product discount configuration', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'PERCENTAGE',
          productDiscountPercentage: 10,
          productMaxDiscountAmount: 5000,
        }),
      );
      await service.updatePromo('promo-1', { title: 'Renamed' } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.title).toBe('Renamed');
      // sparse: dto did not include product fields, so update payload should not overwrite them
      expect(data).not.toHaveProperty('productDiscountType');
      expect(data).not.toHaveProperty('productDiscountPercentage');
    });

    it('sparse update preserves existing shipping discount configuration', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          shippingDiscountType: 'FREE_SHIPPING',
          eligibleCouriers: ['jne'],
        }),
      );
      await service.updatePromo('promo-1', { isActive: false } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.isActive).toBe(false);
      expect(data).not.toHaveProperty('shippingDiscountType');
      expect(data).not.toHaveProperty('eligibleCouriers');
    });

    it('updating product component does not mutate shipping component in update payload', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'PERCENTAGE',
          productDiscountPercentage: 10,
          shippingDiscountType: 'FIXED',
          shippingDiscountAmount: 3000,
          eligibleCouriers: ['paxel'],
        }),
      );
      await service.updatePromo('promo-1', {
        productDiscountType: 'FIXED',
        productDiscountAmount: 7000,
        productDiscountPercentage: null,
      } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.productDiscountType).toBe('FIXED');
      expect(data.productDiscountAmount).toBe(7000);
      expect(data).not.toHaveProperty('shippingDiscountType');
      expect(data).not.toHaveProperty('shippingDiscountAmount');
      expect(data).not.toHaveProperty('eligibleCouriers');
    });

    it('updating shipping component does not mutate product component in update payload', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'FIXED',
          productDiscountAmount: 7000,
          shippingDiscountType: 'FREE_SHIPPING',
          eligibleCouriers: ['jne'],
        }),
      );
      await service.updatePromo('promo-1', {
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 4000,
        eligibleCouriers: ['paxel'],
      } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.shippingDiscountType).toBe('FIXED');
      expect(data.shippingDiscountAmount).toBe(4000);
      expect(data.eligibleCouriers).toEqual(['paxel']);
      expect(data).not.toHaveProperty('productDiscountType');
      expect(data).not.toHaveProperty('productDiscountAmount');
    });

    it('explicit null clears only product component fields', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'PERCENTAGE',
          productDiscountPercentage: 10,
          productDiscountAmount: null,
          productMaxDiscountAmount: 5000,
          shippingDiscountType: 'FREE_SHIPPING',
          eligibleCouriers: ['jne'],
        }),
      );
      await service.updatePromo('promo-1', { productDiscountType: null } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.productDiscountType).toBeNull();
      expect(data.productDiscountPercentage).toBeNull();
      expect(data.productDiscountAmount).toBeNull();
      expect(data.productMaxDiscountAmount).toBeNull();
      // shipping untouched in payload
      expect(data).not.toHaveProperty('shippingDiscountType');
      expect(data).not.toHaveProperty('eligibleCouriers');
    });

    it('explicit null clears only shipping component fields and eligibleCouriers', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          productDiscountType: 'FIXED',
          productDiscountAmount: 7000,
          shippingDiscountType: 'FIXED',
          shippingDiscountAmount: 3000,
          shippingDiscountPercentage: null,
          shippingMaxDiscountAmount: 5000,
          eligibleCouriers: ['paxel'],
        }),
      );
      await service.updatePromo('promo-1', { shippingDiscountType: null } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.shippingDiscountType).toBeNull();
      expect(data.shippingDiscountPercentage).toBeNull();
      expect(data.shippingDiscountAmount).toBeNull();
      expect(data.shippingMaxDiscountAmount).toBeNull();
      expect(data.eligibleCouriers).toBeNull();
      expect(data).not.toHaveProperty('productDiscountType');
      expect(data).not.toHaveProperty('productDiscountAmount');
    });

    it('unrelated legacy fields remain unchanged on sparse update', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          voucherType: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 15,
          minimumOrderAmount: 50000,
          maxUsageCount: 100,
        }),
      );
      await service.updatePromo('promo-1', { description: 'updated' } as any);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.description).toBe('updated');
      expect(data).not.toHaveProperty('voucherType');
      expect(data).not.toHaveProperty('discountPercentage');
      expect(data).not.toHaveProperty('minimumOrderAmount');
      expect(data).not.toHaveProperty('maxUsageCount');
    });

    it('rejects invalid updates (shipping component without eligible couriers)', async () => {
      prisma.promo.findUnique.mockResolvedValue(existingPromo());
      await expect(
        service.updatePromo('promo-1', { shippingDiscountType: 'FREE_SHIPPING' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.promo.update).not.toHaveBeenCalled();
    });

    it('rejects invalid updates (unsupported courier) and does not write', async () => {
      prisma.promo.findUnique.mockResolvedValue(existingPromo());
      await expect(
        service.updatePromo('promo-1', {
          shippingDiscountType: 'FREE_SHIPPING',
          eligibleCouriers: ['sicepat'],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.promo.update).not.toHaveBeenCalled();
    });

    it('new component configuration does not accidentally activate legacy discount fields', async () => {
      prisma.promo.findUnique.mockResolvedValue(
        existingPromo({
          voucherType: 'PERCENTAGE_DISCOUNT',
          discountPercentage: 10, // legacy field present on record
        }),
      );
      await service.updatePromo('promo-1', {
        productDiscountType: 'FIXED',
        productDiscountAmount: 9000,
      } as any);
      expect(prisma.promo.update).toHaveBeenCalledTimes(1);
      const data = prisma.promo.update.mock.calls[0][0].data;
      expect(data.productDiscountType).toBe('FIXED');
      expect(data.productDiscountAmount).toBe(9000);
      // service must not reintroduce/activate legacy fields in the update payload.
      // Phase 4N.12: the stale legacy value is now inert under the component
      // configuration, so the switch clears it; already-null columns are not written.
      expect(data.discountPercentage).toBeNull();
      expect(data).not.toHaveProperty('discountAmount');
      expect(data).not.toHaveProperty('voucherType');
    });
  });
});
