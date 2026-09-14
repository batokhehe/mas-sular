/**
 * Admin Topping management - the form's rules, PURE (no fetch, no React) so they are
 * testable with node --test. They mirror the API's CreateToppingDto/UpdateToppingDto:
 * a trimmed, non-empty name of at most 100 characters, a whole-rupiah price >= 0
 * (0 is a free extra), and an active flag. The API validates again; this only saves a
 * round trip and gives the admin a readable message.
 */

export type AdminTopping = {
  id: string;
  name: string;
  price: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** What the form holds: price stays the raw input text until it is validated. */
export type ToppingFormValues = {
  name: string;
  price: string;
  isActive: boolean;
};

/** What the API receives. */
export type ToppingPayload = {
  name: string;
  price: number;
  isActive: boolean;
};

export const TOPPING_NAME_MAX = 100;

export function toppingFormValues(topping?: Partial<AdminTopping>): ToppingFormValues {
  return {
    name: topping?.name ?? '',
    price: topping?.price === undefined ? '' : String(topping.price),
    // A new topping starts active, exactly like the database default.
    isActive: topping?.isActive ?? true,
  };
}

export type ToppingFormResult = { ok: true; payload: ToppingPayload } | { ok: false; errors: Partial<Record<keyof ToppingFormValues, string>> };

export function validateToppingForm(values: ToppingFormValues): ToppingFormResult {
  const errors: Partial<Record<keyof ToppingFormValues, string>> = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Enter a topping name.';
  else if (name.length > TOPPING_NAME_MAX) errors.name = `Use at most ${TOPPING_NAME_MAX} characters.`;

  const rawPrice = values.price.trim();
  const price = Number(rawPrice);
  if (!rawPrice) errors.price = 'Enter a price (0 for a free topping).';
  else if (!/^\d+$/.test(rawPrice) || !Number.isSafeInteger(price)) errors.price = 'Use whole rupiah, for example 5000.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, payload: { name, price, isActive: values.isActive } };
}

export function toppingStatusLabel(topping: Pick<AdminTopping, 'isActive'>): { label: string; tone: 'active' | 'inactive' } {
  return topping.isActive ? { label: 'Active', tone: 'active' } : { label: 'Inactive', tone: 'inactive' };
}
