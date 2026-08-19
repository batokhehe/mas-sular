/**
 * Shared Indonesian number/currency formatting (architecture audit M3).
 * PURE — no React, no environment access; Intl only via toLocaleString.
 *
 * NOTE: lib/system/*-view.ts files intentionally keep their own local copies —
 * they run under `node --test` with zero runtime imports (the '@/' alias does
 * not resolve there), so pulling this module in would break the test runner.
 */

/** Thousand-separated number: 1234567 → "1.234.567". */
export function formatNumberID(n: number): string {
  return n.toLocaleString('id-ID');
}

/** Rupiah with rounding: 12345.6 → "Rp 12.346" (dashboard/order totals). */
export function formatRupiah(n: number): string {
  return `Rp ${Math.round(n).toLocaleString('id-ID')}`;
}

/** Rupiah without rounding — for values that are already integers by contract. */
export function formatRupiahExact(n: number): string {
  return `Rp ${n.toLocaleString('id-ID')}`;
}
