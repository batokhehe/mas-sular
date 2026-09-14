import { IsInt, IsString, Matches, Max, Min } from 'class-validator';

export class ShippingRateDto {
  @IsString()
  @Matches(/^\d{5}$/, { message: 'originPostalCode must be a 5-digit postal code' })
  originPostalCode!: string;

  @IsString()
  @Matches(/^\d{5}$/, { message: 'destinationPostalCode must be a 5-digit postal code' })
  destinationPostalCode!: string;

  @IsInt()
  @Min(1)
  @Max(50_000)
  weightGram!: number;
}
