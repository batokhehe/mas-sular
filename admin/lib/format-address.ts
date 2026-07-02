import type { AdminAddress } from './admin';

/**
 * Render an address for admin detail panels. Uses the administrative hierarchy
 * when present; falls back to the free-text `fullAddress` for legacy addresses
 * (null region ids) so existing orders/customers never break.
 */
export function formatAdminAddressLine(address: AdminAddress): string {
  if (address.province || address.city || address.district || address.village) {
    return [
      address.addressDetail || address.fullAddress,
      address.village ? `Kel. ${address.village.name}` : null,
      address.district ? `Kec. ${address.district.name}` : null,
      address.city?.name ?? null,
      address.province?.name ?? null,
      address.postalCode ?? address.village?.postalCode ?? null,
    ]
      .filter(Boolean)
      .join(', ');
  }
  return address.fullAddress;
}
