import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { queryBoolean } from '../../../../common/validation/strict-boolean';

export class ListProductsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: ['popular', 'price-low', 'price-high', 'rating'] })
  @IsOptional()
  @IsIn(['popular', 'price-low', 'price-high', 'rating'])
  sort?: 'popular' | 'price-low' | 'price-high' | 'rating';

  /**
   * P2 #10: `?promoSpecial=true` narrows the list to Promo Special products (the
   * homepage "Promo Spesial Produk" section); `false` to the rest. Parsed from the
   * RAW query value (see queryBoolean). Anything else is rejected by @IsBoolean.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  promoSpecial?: boolean;

  /** P2 #11: `?trialPack=true|false` - the homepage "Trial Pack" section. Same rules as promoSpecial. */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(queryBoolean)
  @IsBoolean()
  trialPack?: boolean;
}
