import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_PRODUCT_IMAGES } from '../../../upload/product-image-url';
import { ProductStatus } from '@prisma/client';
import { rawBoolean } from '../../../../common/validation/strict-boolean';

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  slug?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  originalPrice?: number;

  /** Cover. Changing it alone also updates the gallery's first image (P2 D2). */
  @IsOptional()
  @IsString()
  imageUrl?: string;

  /**
   * P2 gallery. Omitted = unchanged. Sent = the COMPLETE ordered list (images[0] =
   * cover); [] is rejected, at most 8, no duplicates, new urls must be app uploads.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCT_IMAGES)
  @IsString({ each: true })
  images?: string[];

  @IsOptional()
  @IsInt()
  spicyLevel?: number;

  @IsOptional()
  @IsBoolean()
  isBestSeller?: boolean;

  @IsOptional()
  @IsBoolean()
  isNew?: boolean;

  // P2 #10 / #11: omitted = unchanged. Raw value validated - see CreateProductDto.
  @IsOptional()
  @Transform(rawBoolean)
  @IsBoolean()
  isPromoSpecial?: boolean;

  @IsOptional()
  @Transform(rawBoolean)
  @IsBoolean()
  isTrialPack?: boolean;

  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @IsInt()
  stock?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

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
