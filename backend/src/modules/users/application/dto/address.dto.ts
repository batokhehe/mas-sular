import {
  IsBoolean,
  IsNumber,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsCoordinatePair } from '../validators/is-coordinate-pair.validator';

/**
 * True once the caller has supplied EITHER axis. Both fields validate together
 * from that point, so a half-supplied pair is rejected rather than silently
 * writing one axis against the other's stale value.
 */
const coordinateSupplied = (dto: { latitude?: number; longitude?: number }): boolean =>
  dto.latitude !== undefined || dto.longitude !== undefined;

export class CreateAddressDto {
  @IsString()
  label!: string;

  @IsString()
  @MinLength(2)
  recipientName!: string;

  @IsString()
  @Length(10, 15)
  phone!: string;

  @IsString()
  @MinLength(10)
  fullAddress!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsNumber()
  latitude!: number;

  @IsNumber()
  longitude!: number;

  @IsBoolean()
  isDefault!: boolean;

  // --- Indonesian administrative hierarchy (optional for backward compatibility;
  // the new chain-select forms send them, legacy/free-text callers may omit). ---
  @IsOptional()
  @IsString()
  addressDetail?: string;

  @IsOptional()
  @IsString()
  provinceId?: string;

  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  villageId?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'postalCode must be numeric' })
  @Length(5, 5, { message: 'postalCode must be exactly 5 digits' })
  postalCode?: string;
}

export class UpdateAddressDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @Length(10, 15)
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  fullAddress?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  /**
   * PAXELBOX-61AG.3.7. Validated as a PAIR, and only when the caller actually
   * sends one — `@ValidateIf` rather than `@IsOptional()`, so that supplying just
   * one axis fails on the missing one instead of being skipped.
   *
   * This is the guard that stops `PATCH {latitude: 0, longitude: 0}` from
   * replacing a geocoded pin with the address form's placeholder. It changes no
   * geocoding behaviour: a coordinate-only patch still does NOT call Google.
   */
  @ValidateIf(coordinateSupplied)
  @IsNumber()
  @IsCoordinatePair()
  latitude?: number;

  @ValidateIf(coordinateSupplied)
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsString()
  addressDetail?: string;

  @IsOptional()
  @IsString()
  provinceId?: string;

  @IsOptional()
  @IsString()
  cityId?: string;

  @IsOptional()
  @IsString()
  districtId?: string;

  @IsOptional()
  @IsString()
  villageId?: string;

  @IsOptional()
  @IsNumberString({ no_symbols: true }, { message: 'postalCode must be numeric' })
  @Length(5, 5, { message: 'postalCode must be exactly 5 digits' })
  postalCode?: string;
}
