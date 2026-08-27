/**
 * Pure view helper for the checkout shipping selector. No React, no fetch —
 * unit-testable standalone, mirroring `lib/payments/channel-view.ts`.
 *
 * Grouping is PRESENTATIONAL ONLY. The option objects are passed through by
 * reference, never cloned, so selecting a grouped option selects the exact same
 * object the backend response produced and the submit payload is unaffected.
 */

import type { ShippingOption } from '@/lib/types/models'

export interface ShippingProviderGroup {
  /** The backend's stable machine id (`ShippingQuote.provider`), e.g. 'paxel'. */
  provider: string
  /** Display heading only — never used to group. */
  title: string
  options: ShippingOption[]
}

/**
 * Display names for providers we already ship with. This map is for LABELS
 * ONLY; grouping keys off `option.provider`, so a provider missing from here
 * still renders (under its own capitalised code) rather than disappearing.
 */
const PROVIDER_TITLES: Record<string, string> = {
  paxel: 'Paxel',
  jne: 'JNE',
}

/** Heading text for a provider id, with a generic fallback for future ones. */
export function providerTitle(provider: string): string {
  const known = PROVIDER_TITLES[provider.toLowerCase()]
  if (known) return known
  if (!provider) return 'Lainnya'
  return provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Group shipping options by their stable `provider` id.
 *
 * - Provider order follows first appearance in the backend response.
 * - Service order within a provider follows the backend response.
 * - The input array and its objects are never mutated.
 * - Groups are built on demand, so an empty group can never be produced.
 */
export function groupShippingOptions(
  options: readonly ShippingOption[],
): ShippingProviderGroup[] {
  const groups: ShippingProviderGroup[] = []
  const byProvider = new Map<string, ShippingProviderGroup>()

  for (const option of options) {
    let group = byProvider.get(option.provider)
    if (!group) {
      group = { provider: option.provider, title: providerTitle(option.provider), options: [] }
      byProvider.set(option.provider, group)
      groups.push(group)
    }
    // Same object reference as the input — selection identity depends on it.
    group.options.push(option)
  }

  return groups
}
