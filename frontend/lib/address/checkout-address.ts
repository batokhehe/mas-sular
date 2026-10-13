/**
 * P2 #7 / #17 / #18 — the Checkout ↔ Address Book round trip.
 *
 * Pure helpers (no React, no aliases) so they can be unit-tested with node --test.
 */

export const CHECKOUT_PATH = '/checkout'
export const ADDRESS_BOOK_PATH = '/account/addresses'
export const RETURN_PARAM = 'returnTo'

/**
 * Where the Address Book may send the customer back to. An ALLOWLIST of exact
 * internal paths: the query value is only ever compared, never navigated to, so
 * an external URL, `//host`, `javascript:` or a look-alike path cannot become a
 * redirect target.
 */
const RETURN_TARGETS = [CHECKOUT_PATH] as const
export type AddressBookReturn = (typeof RETURN_TARGETS)[number]

/** The Address Book link Checkout uses ("Change address"). */
export const ADDRESS_BOOK_FROM_CHECKOUT = `${ADDRESS_BOOK_PATH}?${RETURN_PARAM}=${encodeURIComponent(CHECKOUT_PATH)}`

/** A known return target, or null — null means "a normal, direct Address Book visit". */
export function safeAddressBookReturn(value: string | null | undefined): AddressBookReturn | null {
  return RETURN_TARGETS.find((target) => target === value) ?? null
}

interface SelectableAddress {
  id: string
  isDefault: boolean
}

/**
 * Which address Checkout starts with:
 *  1. the customer's deliberate choice, while it is still one of THEIR addresses;
 *  2. otherwise their default (primary) address;
 *  3. otherwise their only address;
 *  4. otherwise nothing — several addresses and no default is the customer's call.
 * The stored choice is only a hint; the backend still checks ownership on every use.
 */
export function resolveCheckoutAddressId(
  addresses: readonly SelectableAddress[],
  chosenId: string | null | undefined,
): string | null {
  if (chosenId && addresses.some((a) => a.id === chosenId)) return chosenId
  const primary = addresses.find((a) => a.isDefault)
  if (primary) return primary.id
  return addresses.length === 1 ? addresses[0].id : null
}
