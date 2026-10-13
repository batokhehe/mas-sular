/**
 * Admin Order Detail — how one ordered item is priced, from the ORDER'S OWN
 * snapshots only: `OrderItem.unitPrice` and each `OrderItemTopping.price` are
 * copied at checkout, so a later catalog price change never rewrites what an
 * existing order shows. PURE — no fetch, no catalog, no React.
 *
 * Mirrors the checkout formula (orders.service getCartPricing):
 *   line total = (unitPrice + sum of topping prices) x quantity
 */

export interface OrderItemPricingInput {
  unitPrice: number;
  quantity: number;
  toppings?: ReadonlyArray<{ toppingId?: string; name: string; price: number }> | null;
}

export interface OrderItemPricingView {
  /** Base product price per unit (the item's own snapshot). */
  unitPrice: number;
  /** Chosen toppings with the price stored on the order. */
  toppings: Array<{ key: string; name: string; price: number }>;
  /** Sum of topping prices for ONE unit. */
  toppingsPerUnit: number;
  /** Price of one unit including its toppings. */
  unitTotal: number;
  /** What this line contributes to the order subtotal. */
  lineTotal: number;
}

export function orderItemPricing(item: OrderItemPricingInput): OrderItemPricingView {
  const toppings = (item.toppings ?? []).map((t, i) => ({ key: t.toppingId ?? `${t.name}-${i}`, name: t.name, price: t.price }));
  const toppingsPerUnit = toppings.reduce((sum, t) => sum + t.price, 0);
  const unitTotal = item.unitPrice + toppingsPerUnit;
  return { unitPrice: item.unitPrice, toppings, toppingsPerUnit, unitTotal, lineTotal: unitTotal * item.quantity };
}
