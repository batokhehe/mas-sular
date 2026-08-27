/**
 * Checkout logo assets keyed solely by the backend's stable provider id.
 *
 * Keep this separate from service names: a provider may return mock-labelled,
 * renamed, or newly added services without changing its brand artwork.
 */
const PROVIDER_LOGOS: Readonly<Record<string, string>> = {
  paxel: '/paxel-logo.jpeg',
  jne: '/jne-logo.jpg',
}

/** Returns a supplied logo asset for a known provider, if one exists. */
export function providerLogoSrc(provider: string): string | undefined {
  return PROVIDER_LOGOS[provider.toLowerCase()]
}
