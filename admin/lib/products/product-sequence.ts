/**
 * Admin -> Produk ordering (Product.sequence) — PURE helpers behind the product list.
 * No React, no fetch, so every rule is unit-testable.
 *
 * `sequence` is the canonical catalogue position: the Admin list and every storefront
 * list use it by default (the server applies `sequence ASC`, see
 * backend/src/modules/catalog/product-sequence.ts). The admin sets it by dragging rows;
 * the server owns the numbering and rewrites the whole live set to 1..N.
 */

export const PRODUCT_SEQUENCE_SORT = 'sequence' as const;

/** Sort dropdown: the canonical order first (and the default), then the explicit sorts. */
export const PRODUCT_SORT_OPTIONS = [
  { label: 'Urutan Produk', value: PRODUCT_SEQUENCE_SORT },
  { label: 'Terbaru', value: 'createdAt' },
  { label: 'Nama A → Z', value: 'nameAsc' },
  { label: 'Stok Rendah → Tinggi', value: 'stockAsc' },
  { label: 'Stok Tinggi → Rendah', value: 'stockDesc' },
] as const;
export type ProductSortValue = (typeof PRODUCT_SORT_OPTIONS)[number]['value'];
export const DEFAULT_PRODUCT_SORT: ProductSortValue = PRODUCT_SEQUENCE_SORT;

export const PRODUCT_STATUS_FILTER_OPTIONS = ['ALL', 'ACTIVE', 'DRAFT', 'ARCHIVED'] as const;
export type ProductStatusFilter = (typeof PRODUCT_STATUS_FILTER_OPTIONS)[number];

/** Shown instead of a working drag handle when the list is not in canonical order. */
export const REORDER_DISABLED_HINT =
  'Hapus pencarian dan filter, lalu pilih urutan "Urutan Produk" untuk mengatur urutan.';

type Sortable = { sequence: number; name: string; stock: number; createdAt: string; id: string };

/** The list view state that decides whether a drag means anything. */
export type ListView = { sort: ProductSortValue; search: string; statusFilter: ProductStatusFilter };

/**
 * Dragging row 3 above row 7 of a SEARCHED, FILTERED or differently sorted list has no
 * well-defined meaning - the rows next to each other on screen are not the rows next to
 * each other in the catalogue - so reordering is possible only on the full list in
 * canonical order. The page disables the handle and shows REORDER_DISABLED_HINT
 * otherwise, and never sends a reorder request.
 */
export function isReorderable(view: ListView): boolean {
  return view.sort === PRODUCT_SEQUENCE_SORT && view.search.trim() === '' && view.statusFilter === 'ALL';
}

/**
 * Client-side ordering of the fetched list. `sequence` mirrors the server's total order
 * (sequence ASC, then newest, then id) so the admin sees exactly the stored order; the
 * other options are the existing explicit admin sorts, unchanged.
 */
export function sortProducts<T extends Sortable>(products: readonly T[], sort: ProductSortValue): T[] {
  const next = [...products];
  if (sort === 'nameAsc') return next.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'stockAsc') return next.sort((a, b) => a.stock - b.stock);
  if (sort === 'stockDesc') return next.sort((a, b) => b.stock - a.stock);
  if (sort === 'createdAt') return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return next.sort(
    (a, b) => a.sequence - b.sequence || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
  );
}

/** Move one row up (-1) or down (+1) — the keyboard equivalent of a drag. Out-of-range moves change nothing. */
export function moveProduct<T>(products: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= products.length || target < 0 || target >= products.length) return [...products];
  const next = [...products];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Drop the row at `from` onto position `to` (the rows in between shift up/down). */
export function applyDrag<T>(products: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= products.length || to >= products.length) return [...products];
  const next = [...products];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The reorder request body: the COMPLETE list in its new order, numbered 1..N. The
 * server re-validates that it is the whole live set and a real permutation, and refuses
 * a stale snapshot with 409.
 */
export function reorderPayload(products: readonly { id: string }[]): { items: { id: string; sequence: number }[] } {
  return { items: products.map((product, index) => ({ id: product.id, sequence: index + 1 })) };
}

/** Nothing moved → nothing to send. */
export function sameOrder(before: readonly { id: string }[], after: readonly { id: string }[]): boolean {
  return before.length === after.length && before.every((product, index) => product.id === after[index].id);
}
