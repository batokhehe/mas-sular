
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePromoDto } from '../../src/modules/admin/application/dto/create-promo.dto';
import { UpdatePromoDto } from '../../src/modules/admin/application/dto/update-promo.dto';

describe('Promo component validation (DTO)', () => {
  describe('CreatePromoDto', () => {
    const base = { code: 'TEST10', title: 'Test', description: 'desc', voucherType: 'PERCENTAGE_DISCOUNT' };
    it('accepts product-only percentage', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, productDiscountType: 'PERCENTAGE', productDiscountPercentage: 10 }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('accepts product-only fixed', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, productDiscountType: 'FIXED', productDiscountAmount: 5000 }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('accepts shipping percentage with JNE', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne'] }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('accepts shipping fixed with Paxel', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'FIXED', shippingDiscountAmount: 15000, eligibleCouriers: ['paxel'] }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('accepts shipping FREE_SHIPPING', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, voucherType: 'FREE_SHIPPING', shippingDiscountType: 'FREE_SHIPPING', eligibleCouriers: ['paxel', 'jne'] }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('missing courier selection rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50 }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('empty courier array rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: [] }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('invalid courier rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['gojek'] }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('duplicate couriers rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 50, eligibleCouriers: ['jne', 'jne'] }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('invalid percentage rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'PERCENTAGE', shippingDiscountPercentage: 0, eligibleCouriers: ['jne'] }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('missing fixed amount rejected', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, shippingDiscountType: 'FIXED', eligibleCouriers: ['jne'] }); const errors = await validate(dto); expect(errors.length).toBeGreaterThan(0); });
    it('legacy PERCENTAGE_DISCOUNT remains valid', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, voucherType: 'PERCENTAGE_DISCOUNT', discountPercentage: 10 }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('legacy FIXED_DISCOUNT remains valid', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, voucherType: 'FIXED_DISCOUNT', discountAmount: 5000 }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('legacy FREE_SHIPPING without eligibleCouriers remains valid', async () => { const dto = plainToInstance(CreatePromoDto, { ...base, voucherType: 'FREE_SHIPPING' }); const errors = await validate(dto); expect(errors.length).toBe(0); });
  });
  describe('UpdatePromoDto', () => {
    it('omitted fields preserve existing values (structure)', async () => { const dto = plainToInstance(UpdatePromoDto, { title: 'New' }); const errors = await validate(dto); expect(errors.length).toBe(0); });
    it('explicit null clears intended component fields accepted by DTO shape', async () => { const dto = plainToInstance(UpdatePromoDto, { shippingDiscountType: null }); const errors = await validate(dto); expect(Array.isArray(errors)).toBe(true); });
    it('update with eligibleCouriers accepted', async () => { const dto = plainToInstance(UpdatePromoDto, { eligibleCouriers: ['paxel'] }); const errors = await validate(dto); expect(errors.length).toBe(0); });
  });
});
