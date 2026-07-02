import type { Address } from '@/lib/types/models'

/**
 * Render an address for display. When the administrative hierarchy is present we
 * build the full line (detail → village → district → city → province → postal).
 * Legacy addresses (null region ids) fall back to the free-text `fullAddress`,
 * so existing orders/customers never break.
 */
export function formatAddressLine(address: Address): string {
  if (address.village || address.district || address.city || address.province) {
    const parts = [
      address.addressDetail || address.fullAddress,
      address.village ? `Kel. ${address.village.name}` : null,
      address.district ? `Kec. ${address.district.name}` : null,
      address.city?.name ?? null,
      address.province?.name ?? null,
      address.postalCode ?? address.village?.postalCode ?? null,
    ].filter(Boolean)
    return parts.join(', ')
  }
  return address.fullAddress
}

/** Structured lines for multi-line display (e.g. cards, admin detail panels). */
export function formatAddressBlock(address: Address): string[] {
  const hasHierarchy = !!(address.village || address.district || address.city || address.province)
  if (!hasHierarchy) {
    return [address.fullAddress, address.notes ? `Catatan: ${address.notes}` : ''].filter(Boolean)
  }
  const region = [
    address.village ? `Kel. ${address.village.name}` : null,
    address.district ? `Kec. ${address.district.name}` : null,
    address.city?.name ?? null,
    address.province?.name ?? null,
  ]
    .filter(Boolean)
    .join(', ')
  return [
    address.addressDetail || address.fullAddress,
    region,
    address.postalCode ?? address.village?.postalCode ?? '',
    address.notes ? `Catatan: ${address.notes}` : '',
  ].filter(Boolean)
}

/** True when this address uses the new administrative hierarchy. */
export function hasRegionHierarchy(address: Address): boolean {
  return !!(address.provinceId && address.cityId && address.districtId && address.villageId)
}
