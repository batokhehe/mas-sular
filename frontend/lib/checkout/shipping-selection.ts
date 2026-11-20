/**
 * Keeps the checkout's selected shipping service consistent with the CURRENT
 * options from /checkout/shipping-options - PURE (no React) so node --test can load it.
 *
 * The server decides what is offered (a withheld service such as Paxel Same Day is
 * never in the list, and is refused if named anyway). This only makes sure a
 * selection made from an earlier response - a refetch, a cached list, a service
 * withdrawn in a release - can never stay on screen as if it were still available:
 *   - still offered: keep it, using the fresh option (current price/estimate);
 *   - no longer offered: fall back to the cheapest current option;
 *   - nothing offered: no selection.
 */
export interface SelectableShippingOption {
  provider: string
  service: string
  shippingCost: number
}

export function reconcileShippingSelection<T extends SelectableShippingOption>(
  selected: T | null,
  options: readonly T[],
): T | null {
  if (selected) {
    const current = options.find((o) => o.provider === selected.provider && o.service === selected.service)
    if (current) return current
  }
  if (options.length === 0) return null
  return [...options].sort((a, b) => a.shippingCost - b.shippingCost)[0]
}
