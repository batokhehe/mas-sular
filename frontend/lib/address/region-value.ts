import { regionsApi } from '@/lib/api/regions.api'

/** The full chain-select selection carried by address forms. Ids drive the API;
 *  names are kept so the selection renders without a re-fetch (edit/reload). */
export interface RegionValue {
  provinceId?: string
  provinceName?: string
  cityId?: string
  cityName?: string
  districtId?: string
  districtName?: string
  villageId?: string
  villageName?: string
  postalCode?: string
}

export const EMPTY_REGION: RegionValue = {}

export function isRegionComplete(v: RegionValue | undefined): boolean {
  return !!(v?.provinceId && v?.cityId && v?.districtId && v?.villageId && v?.postalCode)
}

/** Normalize for loose name matching (case/space/punctuation-insensitive). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(kota|kabupaten|kab\.?|kec\.?|kecamatan|kel\.?|kelurahan|desa|provinsi)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

function bestMatch<T extends { name: string }>(items: T[], target?: string): T | undefined {
  if (!target || items.length === 0) return undefined
  const t = norm(target)
  if (!t) return undefined
  return (
    items.find((i) => norm(i.name) === t) ??
    items.find((i) => norm(i.name).includes(t) || t.includes(norm(i.name)))
  )
}

export interface GeocodeParts {
  province?: string // administrative_area_level_1
  city?: string // administrative_area_level_2
  district?: string // administrative_area_level_3
  village?: string // administrative_area_level_4
  postalCode?: string
}

/**
 * Best-effort reverse-geocode → master-table ids. Google returns component *names*,
 * so we walk the chain (province → city → district → village) resolving each level
 * by fuzzy name match against the master API. Any level that fails to match simply
 * stops the chain; the caller keeps whatever resolved plus the free-text address.
 *
 * Uses the existing Google geocoder result — no new map provider is introduced.
 */
export async function resolveRegionFromGeocode(parts: GeocodeParts): Promise<RegionValue> {
  const result: RegionValue = {}
  if (parts.postalCode) result.postalCode = parts.postalCode

  const provinces = await regionsApi.provinces({ search: parts.province ?? '', limit: 100 })
  const province = bestMatch(provinces, parts.province)
  if (!province) return result
  result.provinceId = province.id
  result.provinceName = province.name

  const cities = await regionsApi.cities(province.id, { search: parts.city ?? '', limit: 300 })
  const city = bestMatch(cities, parts.city)
  if (!city) return result
  result.cityId = city.id
  result.cityName = city.name

  const districts = await regionsApi.districts(city.id, { search: parts.district ?? '', limit: 300 })
  const district = bestMatch(districts, parts.district)
  if (!district) return result
  result.districtId = district.id
  result.districtName = district.name

  const villages = await regionsApi.villages(district.id, { search: parts.village ?? '', limit: 400 })
  const village = bestMatch(villages, parts.village)
  if (!village) return result
  result.villageId = village.id
  result.villageName = village.name
  if (village.postalCode) result.postalCode = village.postalCode

  return result
}

/** Extract the admin-hierarchy parts from a Google Geocoder result's components. */
export function partsFromGoogleComponents(components: any[]): GeocodeParts {
  const pick = (type: string) =>
    components.find((c) => Array.isArray(c.types) && c.types.includes(type))?.long_name as
      | string
      | undefined
  return {
    province: pick('administrative_area_level_1'),
    city: pick('administrative_area_level_2'),
    district: pick('administrative_area_level_3'),
    village: pick('administrative_area_level_4'),
    postalCode: pick('postal_code'),
  }
}
