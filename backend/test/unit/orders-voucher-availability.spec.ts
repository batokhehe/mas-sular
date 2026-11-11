import { VoucherType } from '@prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Phase 4I regression suite for the voucher availability gate.
 *
 * These tests run the REAL assertVoucherAvailability (it is never mocked here):
 * the Phase 4B/4C integration specs stub it out, which is exactly what hid the
 * defect where a component-based voucher was rejected for having no legacy
 * discountPercentage / discountAmount.
 */

const USER = 'user-1';

// Every availability-relevant column, all permissive, so each test varies one thing.
const baseVoucher = () => ({
  id: 'voucher-1',
  code: 'PHASE4',
  isActive: true,
  startDate: null as Date | null,
  endDate: null as Date | null,
  maxUsageCount: null as number | null,
  currentUsageCount: 0,
  minimumOrderAmount: 0,
  isNewUserOnly: false,
  voucherType: VoucherType.PERCENTAGE_DISCOUNT,
  // Legacy configuration columns: deliberately empty.
  discountPercentage: null as number | null,
  discountAmount: null as number | null,
  maxDiscountAmount: null as number | null,
  freeShippingMaxAmount: null as number | null,
  // Phase 4 component columns.
  productDiscountType: null as string | null,
  productDiscountPercentage: null as number | null,
  productDiscountAmount: null as number | null,
  productMaxDiscountAmount: null as number | null,
  shippingDiscountType: null as string | null,
  shippingDiscountPercentage: null as number | null,
  shippingDiscountAmount: null as number | null,
  shippingMaxDiscountAmount: null as number | null,
  eligibleCouriers: null as string[] | null,
});

describe('OrdersService voucher availability gate (Phase 4I)', () => {
  let service: OrdersService;
  let orderCount: jest.Mock;
  let voucherUsageFindFirst: jest.Mock;

  // No voucher history and no completed orders: the usage checks pass unless a
  // test says otherwise, so a rejection can only come from the rule under test.
  beforeEach(() => {
    orderCount = jest.fn().mockResolvedValue(0);
    voucherUsageFindFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      order: { count: orderCount },
      voucherUsage: { findFirst: voucherUsageFindFirst },
    };
    service = new OrdersService(prisma as any, {} as any, {} as any, {} as any);
  });

  const assertAvailability = (voucher: any, subtotal = 100000) =>
    (service as any).assertVoucherAvailability(voucher, USER, subtotal);

  describe('component-based vouchers are accepted with empty legacy fields', () => {
    it('1. product PERCENTAGE component', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
      expect(voucher.discountPercentage).toBeNull();
    });

    it('2. product FIXED component', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'FIXED', productDiscountAmount: 5000 };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
      expect(voucher.discountAmount).toBeNull();
    });

    it('3. shipping PERCENTAGE component eligible for paxel', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        eligibleCouriers: ['paxel'],
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('4. shipping FIXED component eligible for jne', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 3000,
        eligibleCouriers: ['jne'],
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('5. FREE_SHIPPING component with an eligible courier', async () => {
      const voucher = { ...baseVoucher(), shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('5b. stacked product and shipping components', async () => {
      const voucher = {
        ...baseVoucher(),
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 3000,
        eligibleCouriers: ['paxel', 'jne'],
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('5c. optional component caps are accepted', async () => {
      const voucher = {
        ...baseVoucher(),
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 15,
        productMaxDiscountAmount: 20000,
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        shippingMaxDiscountAmount: 8000,
        eligibleCouriers: ['jne'],
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });
  });

  describe('courier configuration fails closed', () => {
    it('6. missing eligibleCouriers is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        eligibleCouriers: null,
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('7. empty eligibleCouriers is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        eligibleCouriers: [],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('8. unsupported courier is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['gojek'],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('8b. a supported courier mixed with an unsupported one is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne', 'grab'],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('8c. a non-string courier entry is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: [1 as any],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('8d. a courier list that is not an array is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: 'jne' as any,
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher courier configuration is invalid');
    });

    it('9. a missing shipping provider does not bypass eligibility: the voucher stays valid, the shipping discount is zero', async () => {
      const voucher = {
        ...baseVoucher(),
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        eligibleCouriers: ['jne'],
      };
      // The gate judges the stored configuration, not the courier of this order...
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
      // ...and the engine still refuses to discount shipping without a provider.
      const withoutProvider = service.calculateVoucherDiscountBreakdown(voucher as any, 100000, 10000);
      expect(withoutProvider.shippingDiscountAmount).toBe(0);
      expect(withoutProvider.productDiscountAmount).toBe(10000);
      expect(withoutProvider.totalDiscountAmount).toBe(10000);
      // An ineligible provider is treated the same way.
      const ineligible = service.calculateVoucherDiscountBreakdown(voucher as any, 100000, 10000, 'paxel');
      expect(ineligible.shippingDiscountAmount).toBe(0);
      expect(ineligible.productDiscountAmount).toBe(10000);
      // The listed courier is the only one that unlocks it.
      const eligible = service.calculateVoucherDiscountBreakdown(voucher as any, 100000, 10000, 'jne');
      expect(eligible.shippingDiscountAmount).toBe(5000);
      expect(eligible.totalDiscountAmount).toBe(15000);
    });
  });

  describe('incomplete component configuration fails closed', () => {
    it('10. product percentage of zero is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: 0 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('10b. product percentage above 100 is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: 101 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('10c. missing product percentage is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: null };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('10d. shipping percentage above 100 is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 200,
        eligibleCouriers: ['jne'],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('10e. a non-integer percentage is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10.5 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11. missing product fixed amount is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'FIXED', productDiscountAmount: null };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11b. a product fixed amount of zero is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'FIXED', productDiscountAmount: 0 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11c. missing shipping fixed amount is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: null,
        eligibleCouriers: ['jne'],
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11d. a negative component cap is rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        productMaxDiscountAmount: -1,
      };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11e. an unrecognised product component type is rejected', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'SOMETHING_ELSE' };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('11f. an unrecognised shipping component type is rejected', async () => {
      const voucher = { ...baseVoucher(), shippingDiscountType: 'SOMETHING_ELSE', eligibleCouriers: ['jne'] };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });
  });

  describe('availability rules still apply to component vouchers', () => {
    const componentVoucher = () => ({
      ...baseVoucher(),
      productDiscountType: 'PERCENTAGE',
      productDiscountPercentage: 10,
    });

    it('12. an inactive voucher is rejected', async () => {
      await expect(assertAvailability({ ...componentVoucher(), isActive: false })).rejects.toThrow(
        'Voucher is not active',
      );
    });

    it('13. an expired voucher is rejected', async () => {
      const endDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await expect(assertAvailability({ ...componentVoucher(), endDate })).rejects.toThrow('Voucher has expired');
    });

    it('13b. a voucher that has not started is rejected', async () => {
      const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await expect(assertAvailability({ ...componentVoucher(), startDate })).rejects.toThrow(
        'Voucher is not valid yet',
      );
    });

    it('14. a subtotal below the minimum order amount is rejected', async () => {
      await expect(assertAvailability({ ...componentVoucher(), minimumOrderAmount: 150000 }, 100000)).rejects.toThrow(
        /Minimum order amount/,
      );
    });

    it('18. the usage limit is still enforced', async () => {
      await expect(
        assertAvailability({ ...componentVoucher(), maxUsageCount: 5, currentUsageCount: 5 }),
      ).rejects.toThrow('Voucher usage limit has been reached');
    });

    it('18b. a voucher already used by this account is rejected', async () => {
      voucherUsageFindFirst.mockResolvedValue({ id: 'usage-1' });
      await expect(assertAvailability(componentVoucher())).rejects.toThrow(
        'This voucher has already been used by your account',
      );
      expect(voucherUsageFindFirst).toHaveBeenCalled();
    });

    it('18c. a new-user-only voucher is rejected for a returning customer', async () => {
      orderCount.mockResolvedValue(2);
      await expect(assertAvailability({ ...componentVoucher(), isNewUserOnly: true })).rejects.toThrow(
        'Voucher is only available for new customers',
      );
      expect(orderCount).toHaveBeenCalled();
    });

    it('18d. a new-user-only voucher is accepted for a first-time customer', async () => {
      await expect(assertAvailability({ ...componentVoucher(), isNewUserOnly: true })).resolves.toBeUndefined();
    });
  });

  describe('legacy vouchers behave exactly as before', () => {
    it('15. legacy PERCENTAGE_DISCOUNT is accepted', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10 };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('15b. legacy PERCENTAGE_DISCOUNT without a percentage is still rejected', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: null };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('16. legacy FIXED_DISCOUNT is accepted', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 5000 };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('16b. legacy FIXED_DISCOUNT with a zero amount is still rejected', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher configuration is invalid');
    });

    it('17. legacy FREE_SHIPPING is accepted', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: 15000 };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('17b. legacy FREE_SHIPPING without a cap is accepted', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: null };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });

    it('17c. legacy FREE_SHIPPING with a negative cap is still rejected', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: -1 };
      await expect(assertAvailability(voucher)).rejects.toThrow('Voucher shipping limit is invalid');
    });

    it('17d. a legacy voucher is not asked for a courier list', async () => {
      const voucher = {
        ...baseVoucher(),
        voucherType: VoucherType.FREE_SHIPPING,
        freeShippingMaxAmount: 15000,
        eligibleCouriers: null,
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });
  });

  describe('mixed legacy and component configuration', () => {
    it('a configured component wins: the inert legacy column is neither required nor reinterpreted', async () => {
      const voucher = {
        ...baseVoucher(),
        voucherType: VoucherType.FIXED_DISCOUNT,
        discountAmount: null,
        productDiscountType: 'FIXED',
        productDiscountAmount: 5000,
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
      const breakdown = service.calculateVoucherDiscountBreakdown(voucher as any, 100000, 10000, 'jne');
      expect(breakdown.productDiscountAmount).toBe(5000);
      expect(breakdown.shippingDiscountAmount).toBe(0);
      expect(breakdown.totalDiscountAmount).toBe(5000);
    });

    it('a stale legacy value alongside a component is not added on top', async () => {
      const voucher = {
        ...baseVoucher(),
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        discountPercentage: 25,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
      const breakdown = service.calculateVoucherDiscountBreakdown(voucher as any, 100000, 10000, 'jne');
      expect(breakdown.productDiscountAmount).toBe(10000);
      expect(breakdown.totalDiscountAmount).toBe(10000);
    });

    it('a component voucher whose type is FREE_SHIPPING is judged on its components', async () => {
      const voucher = {
        ...baseVoucher(),
        voucherType: VoucherType.FREE_SHIPPING,
        freeShippingMaxAmount: 15000,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      };
      await expect(assertAvailability(voucher)).resolves.toBeUndefined();
    });
  });

  describe('previewVoucher with the real availability gate', () => {
    // Only the database lookup is stubbed; the gate and the engine both run.
    const preview = async (voucher: any, dto: any) => {
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      return service.previewVoucher(USER, dto);
    };

    it('accepts a combined component voucher that the old gate rejected', async () => {
      const voucher = {
        ...baseVoucher(),
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 3000,
        eligibleCouriers: ['jne'],
      };
      const result = await preview(voucher, {
        voucher_code: 'phase4',
        subtotal: 100000,
        shipping_cost: 10000,
        shipping_provider: 'jne',
      });
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(13000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(3000);
      expect(result.discount).toBe((result.productDiscountAmount ?? 0) + (result.shippingDiscountAmount ?? 0));
    });

    it('accepts a product-only component voucher with no legacy percentage', async () => {
      const voucher = { ...baseVoucher(), productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 };
      const result = await preview(voucher, { voucher_code: 'phase4', subtotal: 100000 });
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(10000);
    });

    it('still reports an unusable component configuration as invalid', async () => {
      const voucher = {
        ...baseVoucher(),
        shippingDiscountType: 'PERCENTAGE',
        shippingDiscountPercentage: 50,
        eligibleCouriers: [],
      };
      const result = await preview(voucher, {
        voucher_code: 'phase4',
        subtotal: 100000,
        shipping_cost: 10000,
        shipping_provider: 'jne',
      });
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect((result as any).message).toBe('Voucher courier configuration is invalid');
    });

    it('still reports a misconfigured legacy voucher as invalid', async () => {
      const voucher = { ...baseVoucher(), voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: null };
      const result = await preview(voucher, { voucher_code: 'phase4', subtotal: 100000 });
      expect(result.valid).toBe(false);
      expect((result as any).message).toBe('Voucher configuration is invalid');
    });
  });
});
