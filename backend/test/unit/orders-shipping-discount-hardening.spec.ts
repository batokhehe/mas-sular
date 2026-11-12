import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, VoucherType } from '@prisma/client';
import { OrdersService } from '../../src/modules/orders/orders.service';

/**
 * Phase 4N.12 — shipping-discount hardening.
 *
 * A. A voucher whose computed discount is Rp0 is refused (summary, preview and
 *    checkout) and never consumes usage.
 * B. A courier mismatch zeroes ONLY the shipping discount; the product discount of
 *    component and legacy PERCENTAGE / FIXED vouchers is preserved.
 * E. previewVoucher returns the same amount keys on success and failure.
 *
 * The availability gate (assertVoucherAvailability) and the discount engine run
 * for real; only I/O (address, cart, shipping quote, voucher lookup) is stubbed.
 */

const USER = 'user-1';

const baseVoucher = (overrides: Record<string, any> = {}) => ({
  id: 'voucher-1',
  code: 'SHIP',
  isActive: true,
  startDate: null,
  endDate: null,
  maxUsageCount: 10 as number | null,
  currentUsageCount: 0,
  minimumOrderAmount: 0,
  isNewUserOnly: false,
  voucherType: VoucherType.FREE_SHIPPING,
  discountPercentage: null as number | null,
  discountAmount: null as number | null,
  maxDiscountAmount: null as number | null,
  freeShippingMaxAmount: null as number | null,
  productDiscountType: null as string | null,
  productDiscountPercentage: null as number | null,
  productDiscountAmount: null as number | null,
  productMaxDiscountAmount: null as number | null,
  shippingDiscountType: null as string | null,
  shippingDiscountPercentage: null as number | null,
  shippingDiscountAmount: null as number | null,
  shippingMaxDiscountAmount: null as number | null,
  eligibleCouriers: null as string[] | null,
  ...overrides,
});

const shippingOnly = (overrides: Record<string, any> = {}) =>
  baseVoucher({ shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'], ...overrides });

describe('OrdersService shipping-discount hardening (Phase 4N.12)', () => {
  let service: OrdersService;
  let prisma: any;
  let tx: any;

  beforeEach(() => {
    tx = {
      promo: { update: jest.fn().mockResolvedValue({}) },
      voucherUsage: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      order: { count: jest.fn().mockResolvedValue(0) },
      voucherUsage: { findFirst: jest.fn().mockResolvedValue(null) },
      promo: { update: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    service = new OrdersService(prisma, {} as any, {} as any, {} as any);
  });

  /** Stubs every I/O step of computeSummary; the quote decides courier and cost. */
  const stubSummaryIo = (quote: { provider: string | null; shippingCost: number }, voucher: any) => {
    jest.spyOn(service as any, 'assertAddress').mockResolvedValue({ id: 'addr1' });
    jest.spyOn(service as any, 'normalizeItems').mockReturnValue([{ productId: 'p1', quantity: 1, toppingIds: [] }]);
    jest
      .spyOn(service as any, 'getCartPricing')
      .mockResolvedValue({ products: [{ id: 'p1', stock: 10 }], toppings: [], subtotal: 100000, totalItems: 1 });
    jest.spyOn(service as any, 'assertStock').mockImplementation(() => {});
    jest.spyOn(service as any, 'resolveCoverage').mockResolvedValue(null);
    jest.spyOn(service as any, 'getShippingWeightGram').mockReturnValue(1000);
    jest.spyOn(service as any, 'resolveOutletRequest').mockResolvedValue({ outletId: 'out1', request: {}, quotes: [] });
    jest.spyOn(service as any, 'resolveShippingQuote').mockResolvedValue({ ...quote, estimatedDays: '2-3' });
    jest.spyOn(service as any, 'paymentServiceFeeSetting').mockReturnValue({ enabled: false });
    jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
  };

  const summaryDto = { address_id: 'addr1', items: [{ product_id: 'p1', qty: 1 }], voucher_code: 'SHIP' } as any;
  const computeSummary = () => (service as any).computeSummary(USER, summaryDto);

  describe('A. zero-value redemption is refused', () => {
    it('shipping-only voucher + ineligible courier: summary rejects with an actionable message', async () => {
      stubSummaryIo({ provider: 'paxel', shippingCost: 10000 }, shippingOnly());
      const attempt = computeSummary();
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(computeSummary()).rejects.toThrow(
        'This voucher only discounts shipping with JNE. Choose an eligible courier or remove the voucher to continue.',
      );
    });

    it('shipping-only voucher + zero shipping cost: summary rejects with an actionable message', async () => {
      stubSummaryIo({ provider: 'jne', shippingCost: 0 }, shippingOnly());
      await expect(computeSummary()).rejects.toThrow(
        'This voucher only discounts shipping, and this order has no shipping cost to discount. Remove the voucher to continue.',
      );
    });

    it('legacy FREE_SHIPPING on a restricted courier list is refused the same way', async () => {
      const legacy = baseVoucher({ voucherType: VoucherType.FREE_SHIPPING, eligibleCouriers: ['paxel'] });
      stubSummaryIo({ provider: 'jne', shippingCost: 10000 }, legacy);
      await expect(computeSummary()).rejects.toThrow(/only discounts shipping with Paxel/);
    });

    it('a positive discount is still accepted (control)', async () => {
      stubSummaryIo({ provider: 'jne', shippingCost: 10000 }, shippingOnly());
      const summary = await computeSummary();
      expect(summary.discount).toBe(10000);
      expect(summary.shippingDiscountAmount).toBe(10000);
    });

    describe('checkout', () => {
      const checkoutDto = {
        address_id: 'addr1',
        courier: 'paxel',
        items: [{ product_id: 'p1', qty: 1 }],
        voucher_code: 'SHIP',
        payment_method: PaymentMethod.BANK_TRANSFER,
      } as any;

      beforeEach(() => {
        jest.spyOn(service as any, 'assertManualTransferReady').mockResolvedValue(undefined);
        jest.spyOn(service as any, 'assertGatewayChannelReady').mockResolvedValue(undefined);
        stubSummaryIo({ provider: 'paxel', shippingCost: 10000 }, shippingOnly());
      });

      it('fails with the actionable message', async () => {
        await expect(service.checkout(USER, checkoutDto)).rejects.toThrow(
          'This voucher only discounts shipping with JNE. Choose an eligible courier or remove the voucher to continue.',
        );
      });

      it('does not persist a VoucherUsage row and does not increment currentUsageCount', async () => {
        const persist = jest.spyOn(service as any, 'persistOrderWithRetry');
        await expect(service.checkout(USER, checkoutDto)).rejects.toBeInstanceOf(BadRequestException);
        // Refused before persistence: no transaction is opened at all.
        expect(persist).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.voucherUsage.create).not.toHaveBeenCalled();
        expect(tx.promo.update).not.toHaveBeenCalled();
        expect(prisma.promo.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('B. courier mismatch zeroes only the shipping discount', () => {
    const calc = (voucher: any, provider?: string) =>
      service.calculateVoucherDiscountBreakdown(voucher, 100000, 10000, provider);

    it('component voucher keeps its product discount on an ineligible courier', () => {
      const voucher = baseVoucher({
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 5000,
        eligibleCouriers: ['jne'],
      });
      expect(calc(voucher, 'paxel')).toEqual({ productDiscountAmount: 10000, shippingDiscountAmount: 0, totalDiscountAmount: 10000 });
    });

    it('legacy PERCENTAGE voucher with a courier list keeps its product discount on an ineligible courier', () => {
      const voucher = baseVoucher({ voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, eligibleCouriers: ['jne'] });
      expect(calc(voucher, 'paxel')).toEqual({ productDiscountAmount: 10000, shippingDiscountAmount: 0, totalDiscountAmount: 10000 });
    });

    it('legacy PERCENTAGE voucher still honours its maxDiscountAmount on an ineligible courier', () => {
      const voucher = baseVoucher({
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        discountPercentage: 50,
        maxDiscountAmount: 20000,
        eligibleCouriers: ['jne'],
      });
      expect(calc(voucher, 'paxel').productDiscountAmount).toBe(20000);
    });

    it('legacy FIXED voucher with a courier list keeps its product discount on an ineligible courier', () => {
      const voucher = baseVoucher({ voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 7000, eligibleCouriers: ['jne'] });
      expect(calc(voucher, 'paxel')).toEqual({ productDiscountAmount: 7000, shippingDiscountAmount: 0, totalDiscountAmount: 7000 });
    });

    it('legacy vouchers without a courier restriction are unchanged', () => {
      expect(calc(baseVoucher({ voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10 }), 'paxel').totalDiscountAmount).toBe(10000);
      expect(calc(baseVoucher({ voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 7000 }), undefined).totalDiscountAmount).toBe(7000);
      expect(calc(baseVoucher({ voucherType: VoucherType.FREE_SHIPPING }), 'paxel').shippingDiscountAmount).toBe(10000);
    });

    it('shipping discount is zero for an ineligible courier (component and legacy FREE_SHIPPING)', () => {
      expect(calc(shippingOnly(), 'paxel').shippingDiscountAmount).toBe(0);
      expect(calc(baseVoucher({ voucherType: VoucherType.FREE_SHIPPING, eligibleCouriers: ['jne'] }), 'paxel').shippingDiscountAmount).toBe(0);
    });

    it('an eligible courier still receives the configured shipping discount', () => {
      expect(calc(shippingOnly(), 'jne').shippingDiscountAmount).toBe(10000);
      expect(calc(shippingOnly({ shippingDiscountType: 'FIXED', shippingDiscountAmount: 4000 }), 'JNE').shippingDiscountAmount).toBe(4000);
      expect(calc(shippingOnly({ shippingMaxDiscountAmount: 6000 }), 'jne').shippingDiscountAmount).toBe(6000);
      expect(calc(baseVoucher({ voucherType: VoucherType.FREE_SHIPPING, eligibleCouriers: ['jne'] }), 'jne').shippingDiscountAmount).toBe(10000);
    });

    it('summary for a combined voucher on an ineligible courier keeps the product discount (not refused)', async () => {
      const voucher = baseVoucher({
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'FIXED',
        productDiscountAmount: 5000,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      });
      stubSummaryIo({ provider: 'paxel', shippingCost: 10000 }, voucher);
      const summary = await computeSummary();
      expect(summary.productDiscountAmount).toBe(5000);
      expect(summary.shippingDiscountAmount).toBe(0);
      expect(summary.discount).toBe(5000);
      expect(summary.grand_total).toBe(100000 + 10000 - 5000);
    });
  });

  describe('E. preview response shape', () => {
    const preview = (voucher: any, dto: any) => {
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      return service.previewVoucher(USER, { voucher_code: 'ship', subtotal: 100000, ...dto });
    };
    const amountKeys = ['valid', 'discount', 'productDiscountAmount', 'shippingDiscountAmount', 'voucher_type'];

    it('success and failure carry the same amount keys', async () => {
      const ok = await preview(shippingOnly(), { shipping_cost: 10000, shipping_provider: 'jne' });
      const zero = await preview(shippingOnly(), { shipping_cost: 10000, shipping_provider: 'paxel' });
      jest.spyOn(service as any, 'findVoucherByCode').mockRejectedValue(new BadRequestException('Voucher code not found'));
      const notFound = await service.previewVoucher(USER, { voucher_code: 'nope', subtotal: 100000 } as any);

      for (const result of [ok, zero, notFound]) {
        for (const key of amountKeys) expect(result).toHaveProperty(key);
      }
      expect(ok).toEqual({ valid: true, discount: 10000, productDiscountAmount: 0, shippingDiscountAmount: 10000, voucher_type: VoucherType.FREE_SHIPPING });
      expect(zero).toEqual({
        valid: false,
        discount: 0,
        productDiscountAmount: 0,
        shippingDiscountAmount: 0,
        voucher_type: null,
        message: 'This voucher only discounts shipping with JNE. Choose an eligible courier or remove the voucher to continue.',
      });
      expect(notFound).toEqual({
        valid: false,
        discount: 0,
        productDiscountAmount: 0,
        shippingDiscountAmount: 0,
        voucher_type: null,
        message: 'Voucher code not found',
      });
    });

    it('preview and summary agree on a zero-value voucher', async () => {
      const result = await preview(shippingOnly(), { shipping_cost: 0, shipping_provider: 'jne' });
      expect(result.valid).toBe(false);
      stubSummaryIo({ provider: 'jne', shippingCost: 0 }, shippingOnly());
      await expect(computeSummary()).rejects.toThrow((result as any).message);
    });
  });
});
