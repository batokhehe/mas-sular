/**
 * Product physical attributes: parsing and validation for the admin form.
 *
 * These describe the REAL product (its contents), and are what Paxel CREATE
 * sends as items[].weight/length/width/height. They are deliberately NOT the
 * PaxelBox: the box is the outer carton, is chosen purely from total order
 * quantity, and never appears on a Product.
 *
 * Bounds mirror the backend DTO exactly (Create/UpdateProductDto), which in
 * turn mirror Paxel's documented per-item limits. Kept as a pure module so the
 * rules are unit-testable without a browser.
 */

export const PHYSICAL_LIMITS = {
  weightGram: { min: 1, max: 5000, unit: 'gram' },
  lengthCm: { min: 1, max: 50, unit: 'cm' },
  widthCm: { min: 1, max: 50, unit: 'cm' },
  heightCm: { min: 1, max: 50, unit: 'cm' },
} as const;

export type PhysicalNumericField = keyof typeof PHYSICAL_LIMITS;

export const PHYSICAL_NUMERIC_FIELDS = Object.keys(PHYSICAL_LIMITS) as PhysicalNumericField[];

/** Form state: numbers are held as strings so an empty box stays empty. */
export interface PhysicalFormState {
  weightGram: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  isFragile: boolean;
}

/** What actually goes on the wire. Absent keys are omitted by JSON.stringify. */
export interface PhysicalPayload {
  weightGram?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  isFragile?: boolean;
}

interface ProductLike {
  weightGram?: number | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  isFragile?: boolean | null;
}

/**
 * Seed form state from a product. A NULL measurement becomes an EMPTY string,
 * never a 0 or a placeholder - an unmeasured product must look unmeasured.
 */
export function toPhysicalFormState(product?: ProductLike | null): PhysicalFormState {
  const num = (value: number | null | undefined) =>
    value === null || value === undefined ? '' : String(value);
  return {
    weightGram: num(product?.weightGram),
    lengthCm: num(product?.lengthCm),
    widthCm: num(product?.widthCm),
    heightCm: num(product?.heightCm),
    isFragile: product?.isFragile ?? false,
  };
}

/**
 * Validate one numeric field. Empty is VALID (the value stays unset) - the
 * admin is not forced to measure a product just to edit its name.
 */
export function validatePhysicalField(field: PhysicalNumericField, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const { min, max, unit } = PHYSICAL_LIMITS[field];
  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed)) return `${label(field)} must be a number.`;
  // Rejected rather than rounded: a silently rounded measurement is a wrong
  // parcel, and the backend rejects non-integers anyway.
  if (!Number.isInteger(parsed)) return `${label(field)} must be a whole number of ${unit}.`;
  if (parsed < min || parsed > max) return `${label(field)} must be between ${min} and ${max} ${unit}.`;
  return null;
}

/** Every validation error in the current state, in field order. */
export function validatePhysicalState(state: PhysicalFormState): string[] {
  return PHYSICAL_NUMERIC_FIELDS.map((field) => validatePhysicalField(field, state[field])).filter(
    (message): message is string => message !== null,
  );
}

/**
 * Build the outgoing payload.
 *
 * An empty field is OMITTED, not sent as null or 0. The DTO marks these
 * optional, so an omitted key leaves the stored value untouched - which is what
 * makes "edit the product name" safe for a product whose measurements are still
 * NULL. `isFragile` is always sent: it is a real boolean with a real default,
 * not a missing measurement.
 */
export function toPhysicalPayload(state: PhysicalFormState): PhysicalPayload {
  const payload: PhysicalPayload = {};
  for (const field of PHYSICAL_NUMERIC_FIELDS) {
    const trimmed = state[field].trim();
    if (trimmed === '') continue;
    payload[field] = Number(trimmed);
  }
  payload.isFragile = state.isFragile;
  return payload;
}

function label(field: PhysicalNumericField): string {
  switch (field) {
    case 'weightGram':
      return 'Weight';
    case 'lengthCm':
      return 'Length';
    case 'widthCm':
      return 'Width';
    case 'heightCm':
      return 'Height';
  }
}
