import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ProductStatus } from '@prisma/client';
import { rawBoolean } from '../../../../common/validation/strict-boolean';

export class CreateProductDto {
  @IsString()
  slug!: string;

  /**
   * OPTIONAL (P2 #5): SKU is no longer shown in the Admin UI. When omitted or blank,
   * AdminService.createProduct assigns it from the slug (see product-sku.ts). An
   * explicit SKU from an API client is still honoured unchanged.
   */
  @IsOptional()
  @IsString()
  sku?: string;

  @IsString()
  name!: string;

  @IsString()
  description!: string;

  @IsInt()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  originalPrice?: number;

  @IsString()
  imageUrl!: string;

  @IsOptional()
  @IsInt()
  spicyLevel?: number;

  @IsOptional()
  @IsBoolean()
  isBestSeller?: boolean;

  @IsOptional()
  @IsBoolean()
  isNew?: boolean;

  // P2 #10: homepage "Promo Spesial Produk" section. Omitted = false (column default).
  // Validated on the RAW value (see rawBoolean): the global pipe's implicit
  // conversion would turn any string (even "false") into true.
  @IsOptional()
  @Transform(rawBoolean)
  @IsBoolean()
  isPromoSpecial?: boolean;

  // P2 #11: homepage "Trial Pack" section. Same rules as isPromoSpecial.
  @IsOptional()
  @Transform(rawBoolean)
  @IsBoolean()
  isTrialPack?: boolean;

  @IsEnum(ProductStatus)
  status!: ProductStatus;

  @IsInt()
  stock!: number;

  @IsString()
  categoryId!: string;

  // --- Physical attributes for courier booking -------------------------------
  // Optional so the existing catalogue stays valid; when supplied they must be
  // within Paxel's documented per-item bounds, because an out-of-range value is
  // rejected by the courier at booking time rather than at edit time.
  // Weight in grams (Paxel: between 1 and 5000).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  weightGram?: number;

  // Dimensions in centimetres (Paxel: each side between 1 and 50).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  lengthCm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  widthCm?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  heightCm?: number;

  @IsOptional()
  @IsBoolean()
  isFragile?: boolean;

}
