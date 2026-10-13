import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';
import { FIRST_PRODUCT_SEQUENCE } from '../../../catalog/product-sequence';

/** One row of the new catalogue order. */
export class ReorderProductItemDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  /**
   * 1-based position. The whole payload must be a permutation of 1..N over the
   * complete live set; the server checks that (see validateProductReorder) so the
   * browser can never invent a numbering.
   */
  @ApiProperty({ minimum: FIRST_PRODUCT_SEQUENCE })
  @IsInt()
  @Min(FIRST_PRODUCT_SEQUENCE)
  sequence!: number;
}

export class ReorderProductsDto {
  @ApiProperty({ type: [ReorderProductItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ReorderProductItemDto)
  items!: ReorderProductItemDto[];
}
