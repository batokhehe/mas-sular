import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { IsBusinessDateTime } from '../../../../common/validation/is-business-datetime.decorator';
import { VoucherType } from '@prisma/client';

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

  @ValidateIf((dto) => dto.voucherType === VoucherType.PERCENTAGE_DISCOUNT)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  discountPercentage?: number;

  @ValidateIf((dto) => dto.voucherType === VoucherType.FIXED_DISCOUNT)
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
