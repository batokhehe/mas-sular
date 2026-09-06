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
import { Transform } from 'class-transformer';
import { IsCoordinatePair } from '../validators/is-coordinate-pair.validator';
import { IsIndonesianMobile } from '../validators/is-indonesian-mobile.validator';
import { normalizeIndonesianMobile } from '../../../../common/utils/phone.util';

/**
 * Canonicalise the address phone to `628…` BEFORE validation, so what is
 * validated is what is persisted (PAXELBOX-61AG.3.20).
 *
 * A value that cannot be normalised is passed through untouched: the validator
 * then rejects it with a 400. Silently dropping or blanking it here would hide
 * a bad number instead of refusing it.
 */
const toCanonicalMobile = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return normalizeIndonesianMobile(value);
  } catch {
    return value;
  }
};

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

  // Normalised to canonical 628… then validated as an Indonesian MOBILE number.
  // The courier calls this number and Mekari Qontak messages it on WhatsApp, so a
  // landline or a malformed value is refused rather than stored (61AG.3.20).
  @Transform(toCanonicalMobile)
  @IsString()
  @IsIndonesianMobile()
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

  // Same contract as create: omitted leaves the stored number alone; supplied is
  // normalised to 628… and must be a valid Indonesian mobile.
  @IsOptional()
  @Transform(toCanonicalMobile)
  @IsString()
  @IsIndonesianMobile()
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
