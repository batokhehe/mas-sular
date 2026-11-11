import { ArrayNotEmpty, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, Max, Min, Validate, ValidateIf, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { IsBusinessDateTime } from '../../../../common/validation/is-business-datetime.decorator';
import { ProductDiscountType, ShippingDiscountType, VoucherType } from '@prisma/client';

@ValidatorConstraint({ name: 'NoDuplicateCouriers', async: false })
class NoDuplicateCouriersConstraint implements ValidatorConstraintInterface {
  validate(value: any) {
    if (!Array.isArray(value)) return true;
    const set = new Set(value.map((c: any) => String(c).toLowerCase()));
    return set.size === value.length;
  }

  defaultMessage(args: ValidationArguments) {
    return 'eligibleCouriers must not contain duplicates';
  }
}

function NoDuplicateCouriers() {
  return Validate(NoDuplicateCouriersConstraint);
}

export class UpdatePromoDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsEnum(VoucherType)
  voucherType?: VoucherType;

  @ValidateIf((dto) => dto.voucherType === VoucherType.PERCENTAGE_DISCOUNT && !dto.productDiscountType && !dto.shippingDiscountType)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  discountPercentage?: number;

  @ValidateIf((dto) => dto.voucherType === VoucherType.FIXED_DISCOUNT && !dto.productDiscountType && !dto.shippingDiscountType)
  @IsOptional()
  @IsInt()
  @Min(1)
  discountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxDiscountAmount?: number;

  @ValidateIf((dto) => dto.voucherType === VoucherType.FREE_SHIPPING)
  @IsOptional()
  @IsInt()
  @Min(0)
  freeShippingMaxAmount?: number;

  // Product discount component
  @IsOptional()
  @IsEnum(ProductDiscountType)
  productDiscountType?: ProductDiscountType;

  @ValidateIf((dto) => dto.productDiscountType === ProductDiscountType.PERCENTAGE)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  productDiscountPercentage?: number;

  @ValidateIf((dto) => dto.productDiscountType === ProductDiscountType.FIXED)
  @IsOptional()
  @IsInt()
  @Min(1)
  productDiscountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'productMaxDiscountAmount must be at least 1, or omitted/null for no cap' })
  productMaxDiscountAmount?: number;

  // Shipping discount component
  @IsOptional()
  @IsEnum(ShippingDiscountType)
  shippingDiscountType?: ShippingDiscountType;

  @ValidateIf((dto) => dto.shippingDiscountType === ShippingDiscountType.PERCENTAGE)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  shippingDiscountPercentage?: number;

  @ValidateIf((dto) => dto.shippingDiscountType === ShippingDiscountType.FIXED)
  @IsOptional()
  @IsInt()
  @Min(1)
  shippingDiscountAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'shippingMaxDiscountAmount must be at least 1, or omitted/null for no cap' })
  shippingMaxDiscountAmount?: number;

  @ValidateIf((dto) => dto.shippingDiscountType === ShippingDiscountType.PERCENTAGE || dto.shippingDiscountType === ShippingDiscountType.FIXED || dto.shippingDiscountType === ShippingDiscountType.FREE_SHIPPING)
  @IsOptional()
  @ArrayNotEmpty()
  @IsArray()
  @IsString({ each: true })
  @IsIn(['paxel', 'jne'], { each: true })
  @NoDuplicateCouriers()
  eligibleCouriers?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  minimumOrderAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxUsageCount?: number;

  @IsOptional()
  @IsBoolean()
  isNewUserOnly?: boolean;

  /**
   * Promo window boundaries, in BUSINESS time (Asia/Jakarta).
   *
   * The admin form is an `<input type="datetime-local">`, so it sends a naked
   * wall clock such as "2026-09-12T09:59". IsBusinessDateTime turns that into a
   * real instant here, at the boundary, and rejects anything malformed with a
   * 400 — so the service never has to parse and Prisma never sees a string.
   * A value that carries its own offset is respected as the instant it names.
   */
  @IsOptional()
  @IsBusinessDateTime()
  startDate?: Date;

  @IsOptional()
  @IsBusinessDateTime()
  endDate?: Date;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
