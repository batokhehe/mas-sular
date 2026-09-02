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

/**
 * Strip everything but letters and digits, lower-cased. Lets us ask "does this
 * label already say this code?" without caring about spaces, underscores or case.
 */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The service label a customer reads.
 *
 * JNE can return two DIFFERENT services whose `service_display` is identical:
 * `REG15` and `REG19` are both displayed "REG", at prices that differed tenfold
 * in the tariff we measured. Selection was never ambiguous — identity is
 * `provider + service` — but two rows reading "REG" at different prices give the
 * customer nothing to choose between.
 *
 * So the code is appended when, and only when, the name does not already contain
 * it: "REG" + REG15 -> `REG (REG15)`, while "Paxel Same Day" + PAXEL_SAMEDAY and
 * JNE's `JTR<130` + JTR<130 are left exactly as they were. Providers whose names
 * already carry their code see no change at all.
 *
 * Nothing is interpreted. The suffix `15`/`19` is not decoded, not sorted on and
 * not mapped to a meaning — the code is shown verbatim precisely BECAUSE we do
 * not know what it means, and the customer can at least tell the options apart.
 */
export function serviceLabel(option: Pick<ShippingOption, 'service' | 'serviceName'>): string {
  const name = option.serviceName?.trim()
  const code = option.service?.trim()
  if (!code) return name || ''
  if (!name) return code
  return squash(name).includes(squash(code)) ? name : `${name} (${code})`
}
