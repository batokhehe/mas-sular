import { OrdersService } from '../../src/modules/orders/orders.service';
import { PaymentMethod, VoucherType } from '@prisma/client';

describe('OrdersService voucher breakdown integration (Phase 4B)', () => {
  let service: OrdersService;

  beforeEach(() => {
    service = new OrdersService({} as any, {} as any, {} as any, {} as any);
  });

  describe('previewVoucher', () => {
    it('returns correct breakdown for product-only voucher', async () => {
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'TEST', subtotal: 100000 } as any);
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });

    it('returns correct breakdown for shipping-only voucher', async () => {
      const voucher = { voucherType: VoucherType.FREE_SHIPPING, shippingDiscountType: 'FREE_SHIPPING', productDiscountType: null, eligibleCouriers: ['jne'], freeShippingMaxAmount: 15000 } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'TEST', subtotal: 100000, shipping_cost: 10000, shipping_provider: 'jne' } as any);
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(10000);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });

    it('returns correct breakdown for combined voucher', async () => {
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 5000,
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'TEST', subtotal: 100000, shipping_cost: 10000, shipping_provider: 'jne' } as any);
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(15000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(5000);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });

    // Phase 4N.12: a voucher whose only discount is shipping, on an ineligible
    // courier, computes Rp0 and is now refused with an actionable message.
    it('ineligible courier on a shipping-only voucher is refused (Rp0)', async () => {
      const voucher = {
        voucherType: VoucherType.FREE_SHIPPING,
        productDiscountType: null,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'TEST', subtotal: 100000, shipping_cost: 10000, shipping_provider: 'paxel' } as any);
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect((result as any).message).toBe('This voucher only discounts shipping with JNE. Choose an eligible courier or remove the voucher to continue.');
    });

    it('missing provider on a shipping-only component voucher is refused (Rp0)', async () => {
      const voucher = {
        voucherType: VoucherType.FREE_SHIPPING,
        productDiscountType: null,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'TEST', subtotal: 100000, shipping_cost: 10000 } as any);
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect((result as any).message).toBe('This voucher only discounts shipping with JNE. Choose a courier first, or remove the voucher to continue.');
    });

    it('existing response fields and error behavior remain backward compatible', async () => {
      jest.spyOn(service as any, 'findVoucherByCode').mockRejectedValue(new Error('Voucher not found'));
      const result = await service.previewVoucher('user1', { voucher_code: 'BAD', subtotal: 100000 } as any);
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
    });

    it('applies eligible Paxel shipping voucher when shipping context provided', async () => {
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 0, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel'], shippingMaxDiscountAmount: 20000 } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'SHIP', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'paxel' } as any);
      expect(result.valid).toBe(true);
      expect(result.shippingDiscountAmount).toBe(15000);
      expect(result.discount).toBe(15000);
    });

    it('applies eligible JNE shipping voucher when shipping context provided', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FIXED', shippingDiscountAmount: 8000, eligibleCouriers: ['jne'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'JNE8', subtotal: 100000, shipping_cost: 12000, shipping_provider: 'jne' } as any);
      expect(result.valid).toBe(true);
      expect(result.shippingDiscountAmount).toBe(8000);
      expect(result.discount).toBe(8000);
    });

    it('rejects a shipping-only voucher for an ineligible courier in preview (Rp0)', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'PAXEL', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'jne' } as any);
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect((result as any).message).toMatch(/only discounts shipping with Paxel/);
    });

    it('fails closed for new shipping discount when courier context missing', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'JNE', subtotal: 100000 } as any);
      // Still fails closed (no shipping discount without a courier); since the
      // voucher would then grant Rp0 it is refused rather than accepted (4N.12).
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect((result as any).message).toMatch(/Choose a courier first/);
    });

    it('handles missing shipping cost in preview (shipping discount limited by 0 cost)', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FIXED', shippingDiscountAmount: 8000, eligibleCouriers: ['jne'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'JNE8', subtotal: 100000, shipping_provider: 'jne' } as any);
      // Rp0 shipping cost leaves a shipping-only voucher with nothing to discount (4N.12).
      expect(result.valid).toBe(false);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
      expect((result as any).message).toBe('This voucher only discounts shipping, and this order has no shipping cost to discount. Remove the voucher to continue.');
    });

    it('preview keeps product discount when shipping courier ineligible', async () => {
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        discountPercentage: 10,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['paxel'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'COMBO', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'jne' } as any);
      expect(result.valid).toBe(true);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.discount).toBe(10000);
    });

    it('preview returns combined discount for eligible courier with context', async () => {
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        discountPercentage: 10,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 5000,
        eligibleCouriers: ['paxel'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'COMBO', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'paxel' } as any);
      expect(result.valid).toBe(true);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(5000);
      expect(result.discount).toBe(15000);
    });

    it('changing courier context changes preview shipping discount result', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const paxel = await service.previewVoucher('user1', { voucher_code: 'PAXEL', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'paxel' } as any);
      const jne = await service.previewVoucher('user1', { voucher_code: 'PAXEL', subtotal: 100000, shipping_cost: 15000, shipping_provider: 'jne' } as any);
      expect(paxel.shippingDiscountAmount).toBe(15000);
      expect(jne.shippingDiscountAmount).toBe(0);
    });

    it('changing shipping cost context changes preview shipping discount result', async () => {
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 0, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel'], shippingMaxDiscountAmount: 20000 } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const low = await service.previewVoucher('user1', { voucher_code: 'PAXEL', subtotal: 100000, shipping_cost: 8000, shipping_provider: 'paxel' } as any);
      const high = await service.previewVoucher('user1', { voucher_code: 'PAXEL', subtotal: 100000, shipping_cost: 18000, shipping_provider: 'paxel' } as any);
      expect(low.shippingDiscountAmount).toBe(8000);
      expect(high.shippingDiscountAmount).toBe(18000);
    });

    it('legacy voucher preview remains backward-compatible without shipping context', async () => {
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await service.previewVoucher('user1', { voucher_code: 'LEGACY', subtotal: 100000 } as any);
      expect(result.valid).toBe(true);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
    });
  });

  describe('computeSummary', () => {
    const setupComputeSummaryMocks = () => {
      jest.spyOn(service as any, 'assertAddress').mockResolvedValue({ id: 'addr1', provinceId: '1', cityId: '1' });
      jest.spyOn(service as any, 'normalizeItems').mockReturnValue([{ productId: 'p1', quantity: 1 }]);
      jest.spyOn(service as any, 'getCartPricing').mockResolvedValue({ products: [{ id: 'p1', stock: 10 }], subtotal: 100000, totalItems: 1 });
      jest.spyOn(service as any, 'assertStock').mockImplementation(() => {});
      jest.spyOn(service as any, 'resolveCoverage').mockResolvedValue(null);
      jest.spyOn(service as any, 'resolveOutletRequest').mockResolvedValue({ outletId: 'out1', request: {}, quotes: [] });
      jest.spyOn(service as any, 'resolveShippingQuote').mockResolvedValue({ shippingCost: 10000, provider: 'jne', estimatedDays: '2-3' });
      jest.spyOn(service as any, 'getShippingWeightGram').mockReturnValue(1000);
      jest.spyOn(service as any, 'paymentServiceFeeSetting').mockReturnValue({ enabled: false });
    };

    it('no voucher: all three discount fields are zero', async () => {
      setupComputeSummaryMocks();
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }] } as any);
      expect(result.discount).toBe(0);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('legacy percentage voucher: correct product breakdown and unchanged total', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });

    it('legacy fixed voucher: correct product breakdown', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.FIXED_DISCOUNT, discountAmount: 5000, productDiscountType: null, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(5000);
      expect(result.productDiscountAmount).toBe(5000);
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('legacy FREE_SHIPPING: correct shipping breakdown', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.FREE_SHIPPING, productDiscountType: null, shippingDiscountType: null, freeShippingMaxAmount: 15000 } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(10000);
    });

    it('new product-only component', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 15, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(15000);
      expect(result.productDiscountAmount).toBe(15000);
      expect(result.shippingDiscountAmount).toBe(0);
    });

    it('new shipping-only component with eligible courier', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.FREE_SHIPPING, productDiscountType: null, shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['jne'] } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(10000);
      expect(result.productDiscountAmount).toBe(0);
      expect(result.shippingDiscountAmount).toBe(10000);
    });

    it('combined product and shipping discount', async () => {
      setupComputeSummaryMocks();
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 5000,
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe(15000);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.shippingDiscountAmount).toBe(5000);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });

    it('ineligible courier: shipping discount zero, product discount retained', async () => {
      setupComputeSummaryMocks();
      (service as any).resolveShippingQuote = jest.fn().mockResolvedValue({ shippingCost: 10000, provider: 'paxel', estimatedDays: '2-3' });
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.shippingDiscountAmount).toBe(0);
      expect(result.productDiscountAmount).toBe(10000);
      expect(result.discount).toBe(10000);
    });

    it('missing resolved provider: new shipping discount fails closed', async () => {
      setupComputeSummaryMocks();
      (service as any).resolveShippingQuote = jest.fn().mockResolvedValue({ shippingCost: 10000, provider: null, estimatedDays: '2-3' });
      const voucher = {
        voucherType: VoucherType.FREE_SHIPPING,
        productDiscountType: null,
        shippingDiscountType: 'FREE_SHIPPING',
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      // Still fails closed; the resulting Rp0 voucher is now refused (4N.12).
      await expect(
        (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any),
      ).rejects.toThrow('This voucher only discounts shipping with JNE. Choose a courier first, or remove the voucher to continue.');
    });

    it('grand total subtracts total discount exactly once', async () => {
      setupComputeSummaryMocks();
      const voucher = { voucherType: VoucherType.PERCENTAGE_DISCOUNT, discountPercentage: 10, productDiscountType: null, shippingDiscountType: null } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.grand_total).toBe(result.subtotal + result.shipping_cost - result.discount + result.payment_service_fee);
      expect(result.discount).toBe(10000);
    });

    it('payment service fee calculation remains unchanged', async () => {
      setupComputeSummaryMocks();
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }] } as any);
      expect(result.payment_service_fee).toBe(0);
      expect(result.payment_service_fee_applies).toBeDefined();
    });

    it('discount always equals productDiscountAmount + shippingDiscountAmount', async () => {
      setupComputeSummaryMocks();
      const voucher = {
        voucherType: VoucherType.PERCENTAGE_DISCOUNT,
        productDiscountType: 'PERCENTAGE',
        productDiscountPercentage: 10,
        shippingDiscountType: 'FIXED',
        shippingDiscountAmount: 3000,
        eligibleCouriers: ['jne'],
      } as any;
      jest.spyOn(service as any, 'findVoucherByCode').mockResolvedValue(voucher);
      jest.spyOn(service as any, 'assertVoucherAvailability').mockResolvedValue(undefined);
      const result = await (service as any).computeSummary('user1', { address_id: 'addr1', items: [{ product_id: 'p1', quantity: 1 }], voucher_code: 'TEST' } as any);
      expect(result.discount).toBe((result.productDiscountAmount || 0) + (result.shippingDiscountAmount || 0));
    });
  });
});
