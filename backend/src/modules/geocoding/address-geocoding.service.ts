import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { Coordinates, GeocodingService } from './geocoding.service';

/** The address fields this module reads. A subset of Create/UpdateAddressDto. */
export interface GeocodableAddress {
  fullAddress?: string;
  addressDetail?: string;
  postalCode?: string;
  provinceId?: string;
  cityId?: string;
  districtId?: string;
  villageId?: string;
}

/**
 * The address fields that change WHERE a parcel goes. Everything else on the DTO
 * — label, recipientName, phone, notes, isDefault, latitude, longitude — names
 * the recipient or the record, not the place, so editing them must not spend a
 * Google request or move an already-correct pin.
 */
export const LOCATION_FIELDS = [
  'fullAddress',
  'addressDetail',
  'postalCode',
  'provinceId',
  'cityId',
  'districtId',
  'villageId',
] as const;

/** True when a partial update touches at least one field that moves the address. */
export function touchesLocation(patch: Record<string, unknown>): boolean {
  return LOCATION_FIELDS.some((f) => patch[f] !== undefined);
}

/**
 * Compose the string Google is asked to resolve.
 *
 * Built from the MOST specific part outward — street text, then village,
 * district, city, province, postal code — because Google weights earlier
 * components more heavily, and finished with "Indonesia" so an Indonesian
 * kelurahan is never matched against a same-named place abroad.
 *
 * Region NAMES, not ids: the DTO carries Kemendagri ids, which mean nothing to
 * Google. Empty parts are dropped rather than emitted as blanks, so an address
 * with no village still produces a clean query instead of "…, , Bandung".
 */
export function buildGeocodeQuery(parts: {
  street?: string | null;
  village?: string | null;
  district?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
}): string {
  return [parts.street, parts.village, parts.district, parts.city, parts.province, parts.postalCode, 'Indonesia']
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join(', ');
}

/**
 * PAXELBOX-61AG.3: turn a submitted address into real coordinates.
 *
 * Sits between the controller and GeocodingService because the query needs
 * region NAMES that only the database holds — the DTO carries ids. Kept out of
 * the controller so the composition is testable without HTTP.
 */
@Injectable()
export class AddressGeocodingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geocoding: GeocodingService,
  ) {}

  get enabled(): boolean {
    return this.geocoding.enabled;
  }

  /** Resolve the region ids on a DTO to their human names. */
  private async regionNames(dto: GeocodableAddress) {
    const [province, city, district, village] = await Promise.all([
      dto.provinceId ? this.prisma.province.findUnique({ where: { id: dto.provinceId }, select: { name: true } }) : null,
      dto.cityId ? this.prisma.city.findUnique({ where: { id: dto.cityId }, select: { name: true } }) : null,
      dto.districtId ? this.prisma.district.findUnique({ where: { id: dto.districtId }, select: { name: true } }) : null,
      dto.villageId ? this.prisma.village.findUnique({ where: { id: dto.villageId }, select: { name: true } }) : null,
    ]);
    return {
      province: province?.name ?? null,
      city: city?.name ?? null,
      district: district?.name ?? null,
      village: village?.name ?? null,
    };
  }

  /**
   * Coordinates for `dto`, or null when the feature is switched off.
   *
   * Null means "not attempted" — the caller keeps whatever it already had.
   * A geocoding FAILURE is never null: it throws, so no fake coordinate can be
   * persisted in its place.
   */
  async coordinatesFor(dto: GeocodableAddress): Promise<Coordinates | null> {
    if (!this.geocoding.enabled) return null;

    const names = await this.regionNames(dto);
    const query = buildGeocodeQuery({
      // `addressDetail` is the street text on the newer chain-select form;
      // `fullAddress` is the legacy free-text field. Prefer the more specific.
      street: dto.addressDetail ?? dto.fullAddress,
      village: names.village,
      district: names.district,
      city: names.city,
      province: names.province,
      postalCode: dto.postalCode,
    });
    return this.geocoding.geocode(query);
  }

  /**
   * Merge geocoded coordinates into the data about to be written.
   *
   * `skipWhenUnchanged` short-circuits an update that touched no location field,
   * so editing a phone number costs no Google request and leaves the existing
   * pin exactly where it was.
   */
  async withCoordinates<T extends GeocodableAddress & Record<string, unknown>>(
    data: T,
    opts: { skipWhenUnchanged?: boolean } = {},
  ): Promise<T> {
    if (!this.geocoding.enabled) return data;
    if (opts.skipWhenUnchanged && !touchesLocation(data)) return data;

    const coords = await this.coordinatesFor(data);
    if (!coords) return data;
    // Client-supplied latitude/longitude are overwritten on purpose: the form
    // sends 0,0 or a hardcoded placeholder (PAXELBOX-61AG.2), and a resolved
    // coordinate is the more trustworthy of the two.
    return { ...data, latitude: coords.latitude, longitude: coords.longitude };
  }
}
