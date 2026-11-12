import { OrdersService } from '../../src/modules/orders/orders.service';
import { VoucherType } from '@prisma/client';

describe('OrdersService voucher calculation', () => {
  let service: OrdersService;

  beforeEach(() => {
    service = new OrdersService({} as any, {} as any, {} as any, {} as any);
  });

  describe('calculateVoucherDiscountBreakdown - product', () => {
    it('product percentage discount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.totalDiscountAmount).toBe(10000);
      expect(result.totalDiscountAmount).toBe(result.productDiscountAmount + result.shippingDiscountAmount);
    });

    it('product fixed discount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 5000, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(5000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.totalDiscountAmount).toBe(5000);
    });

    it('product percentage cap with maxDiscountAmount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 50, maxDiscountAmount: 20000, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(20000);
    });

    it('product fixed capped by subtotal', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 200000, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(100000);
    });

    it('zero subtotal', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any,
        0,
        10000,
      );
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.totalDiscountAmount).toBe(0);
      expect(Number.isInteger(result.totalDiscountAmount)).toBe(true);
    });
  });

  describe('calculateVoucherDiscountBreakdown - shipping', () => {
    it('shipping percentage discount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(5000);
      expect(result.productDiscountAmount).toBe(0);
    });

    it('shipping fixed discount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'FIXED', shippingDiscountAmount: 3000, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'paxel',
      );
      expect(result.shippingDiscountAmount).toBe(3000);
    });

    it('shipping FREE_SHIPPING', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(10000);
    });

    it('shipping percentage cap', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, shippingMaxDiscountAmount: 3000, eligibleCouriers: ['jne'] } as any,
        100000,
        20000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(3000);
    });

    it('shipping fixed cap', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'FIXED', shippingDiscountAmount: 20000, shippingMaxDiscountAmount: 5000, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(5000);
    });

    it('FREE_SHIPPING with configured cap', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', shippingMaxDiscountAmount: 5000, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(5000);
    });

    it('shipping cannot exceed shipping cost', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 200, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBeLessThanOrEqual(10000);
    });

    it('zero shipping cost', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne'] } as any,
        100000,
        0,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(0);
    });
  });

  describe('stacking', () => {
    it('product percentage + shipping percentage', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 20, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(2000);
      expect(result.totalDiscountAmount).toBe(12000);
      expect(result.totalDiscountAmount).toBe(result.productDiscountAmount + result.shippingDiscountAmount);
    });

    it('product fixed + shipping fixed', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'FIXED', productDiscountAmount: 5000, shippingDiscountType: 'FIXED', shippingDiscountAmount: 3000, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'paxel',
      );
      expect(result.productDiscountAmount).toBe(5000);
      expect(result.shippingDiscountAmount).toBe(3000);
      expect(result.totalDiscountAmount).toBe(8000);
    });

    it('product percentage + shipping fixed', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, shippingDiscountType: 'FIXED', shippingDiscountAmount: 3000, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(3000);
      expect(result.totalDiscountAmount).toBe(13000);
    });

    it('product fixed + shipping percentage', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'FIXED', productDiscountAmount: 5000, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'paxel',
      );
      expect(result.productDiscountAmount).toBe(5000);
      expect(result.shippingDiscountAmount).toBe(5000);
      expect(result.totalDiscountAmount).toBe(10000);
    });

    it('total equals sum and non-negative integers', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 15, productMaxDiscountAmount: 20000, shippingDiscountType: 'FIXED', shippingDiscountAmount: 15000, shippingMaxDiscountAmount: 8000, eligibleCouriers: ['jne'] } as any,
        50000,
        12000,
        'jne',
      );
      expect(result.totalDiscountAmount).toBe(result.productDiscountAmount + result.shippingDiscountAmount);
      expect(result.productDiscountAmount).toBeGreaterThanOrEqual(0);
      expect(result.shippingDiscountAmount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(result.productDiscountAmount)).toBe(true);
      expect(Number.isInteger(result.shippingDiscountAmount)).toBe(true);
      expect(result.productDiscountAmount).toBeLessThanOrEqual(50000);
      expect(result.shippingDiscountAmount).toBeLessThanOrEqual(12000);
    });
  });

  describe('courier eligibility', () => {
    it('eligible paxel', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'paxel',
      );
      expect(result.shippingDiscountAmount).toBe(5000);
    });

    it('eligible jne', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(5000);
    });

    it('ineligible courier gives zero shipping discount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('product discount remains when shipping courier ineligible', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['paxel'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.totalDiscountAmount).toBe(10000);
    });

    it('missing eligibleCouriers for new shipping component gives zero shipping', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: null } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('empty eligibleCouriers for new shipping component gives zero shipping', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: [] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('invalid eligibleCouriers for new shipping component gives zero shipping', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: null, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['gojek'] } as any,
        100000,
        10000,
        'jne',
      );
      expect(result.shippingDiscountAmount).toBe(0);
    });
  });

  describe('legacy compatibility', () => {
    it('legacy PERCENTAGE_DISCOUNT mapping', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('legacy FIXED_DISCOUNT mapping', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 5000, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(5000);
    });

    it('legacy FREE_SHIPPING without eligibleCouriers', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: null } as any,
        100000,
        10000,
      );
      expect(result.shippingDiscountAmount).toBe(10000);
      expect(result.productDiscountAmount).toBe(0);
    });

    it('legacy maxDiscountAmount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 50, maxDiscountAmount: 20000, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(20000);
    });

    it('legacy freeShippingMaxAmount', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.FREE_SHIPPING, freeShippingMaxAmount: 5000 } as any,
        100000,
        10000,
      );
      expect(result.shippingDiscountAmount).toBe(5000);
    });

    it('new component does not double-apply legacy voucherType', () => {
      const result = service.calculateVoucherDiscountBreakdown(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 50, productDiscountType: 'FIXED', productDiscountAmount: 5000, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(result.productDiscountAmount).toBe(5000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.totalDiscountAmount).toBe(5000);
    });

    it('calculateVoucherDiscount backward compatibility', () => {
      const total = (service as any).calculateVoucherDiscount(
        { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any,
        100000,
        10000,
      );
      expect(total).toBe(10000);
    });
  });
});
