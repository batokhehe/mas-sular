import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDrag,
  DEFAULT_PRODUCT_SORT,
  isReorderable,
  moveProduct,
  PRODUCT_SEQUENCE_SORT,
  PRODUCT_SORT_OPTIONS,
  PRODUCT_STATUS_FILTER_OPTIONS,
  REORDER_DISABLED_HINT,
  reorderPayload,
  sameOrder,
  sortProducts,
  type ListView,
  type ProductSortValue,
} from './product-sequence.ts';

/**
 * Admin -> Produk ordering. The pure helpers are exercised directly; the page wiring is
 * pinned in the source (no component-render harness in this package). The server-side
 * rules (full-set payload, 1..N permutation, 409 on a stale snapshot, atomicity, audit)
 * are proven in the backend product-sequence specs.
 */

const strip = (src: string) =>
  src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const PAGE = strip(read('app/products/page.tsx'));
const API = read('lib/admin.ts');

const product = (id: string, over: Partial<{ sequence: number; name: string; stock: number; createdAt: string }> = {}) => ({
  id,
  sequence: 0,
  name: id,
  stock: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const ids = (list: readonly { id: string }[]) => list.map((p) => p.id);

// ---------------------------------------------------------------- the sort dropdown

test('the canonical order is an option and the default; the existing admin sorts are unchanged', () => {
  assert.equal(PRODUCT_SEQUENCE_SORT, 'sequence');
  assert.equal(DEFAULT_PRODUCT_SORT, PRODUCT_SEQUENCE_SORT);
  assert.deepEqual(
    PRODUCT_SORT_OPTIONS.map((o) => o.value),
    ['sequence', 'createdAt', 'nameAsc', 'stockAsc', 'stockDesc'],
  );
  assert.deepEqual(
    PRODUCT_SORT_OPTIONS.map((o) => o.label),
    ['Urutan Produk', 'Terbaru', 'Nama A → Z', 'Stok Rendah → Tinggi', 'Stok Tinggi → Rendah'],
  );
  assert.deepEqual([...PRODUCT_STATUS_FILTER_OPTIONS], ['ALL', 'ACTIVE', 'DRAFT', 'ARCHIVED']);
});

test('sortProducts: the sequence mirrors the server order (sequence, then newest, then id)', () => {
  const list = [
    product('c', { sequence: 2 }),
    product('a', { sequence: 1 }),
    product('tie-old', { sequence: 3, createdAt: '2026-01-01T00:00:00.000Z' }),
    product('tie-new', { sequence: 3, createdAt: '2026-06-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(ids(sortProducts(list, 'sequence')), ['a', 'c', 'tie-new', 'tie-old']);
});

test('sortProducts: the explicit admin sorts behave exactly as before', () => {
  const list = [
    product('b', { sequence: 1, name: 'Bakso', stock: 9, createdAt: '2026-02-01T00:00:00.000Z' }),
    product('a', { sequence: 2, name: 'Ayam', stock: 1, createdAt: '2026-03-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(ids(sortProducts(list, 'nameAsc')), ['a', 'b']);
  assert.deepEqual(ids(sortProducts(list, 'stockAsc')), ['a', 'b']);
  assert.deepEqual(ids(sortProducts(list, 'stockDesc')), ['b', 'a']);
  assert.deepEqual(ids(sortProducts(list, 'createdAt')), ['a', 'b']);
});

test('sortProducts never mutates its input', () => {
  const list = [product('b', { sequence: 2 }), product('a', { sequence: 1 })];
  sortProducts(list, 'sequence');
  assert.deepEqual(ids(list), ['b', 'a']);
});

// ---------------------------------------------------------------- when dragging is allowed

const view = (over: Partial<ListView> = {}): ListView => ({ sort: 'sequence', search: '', statusFilter: 'ALL', ...over });

test('reordering is allowed only on the full list in canonical order', () => {
  assert.equal(isReorderable(view()), true);
  assert.equal(isReorderable(view({ search: 'baso' })), false);
  assert.equal(isReorderable(view({ search: '   ' })), true); // whitespace is not a search
  assert.equal(isReorderable(view({ statusFilter: 'ACTIVE' })), false);
  assert.equal(isReorderable(view({ statusFilter: 'ARCHIVED' })), false);
  for (const sort of ['createdAt', 'nameAsc', 'stockAsc', 'stockDesc'] as ProductSortValue[]) {
    assert.equal(isReorderable(view({ sort })), false, sort);
  }
});

test('the hint shown when it is not allowed is Indonesian and names both conditions', () => {
  assert.match(REORDER_DISABLED_HINT, /pencarian/);
  assert.match(REORDER_DISABLED_HINT, /filter/);
  assert.match(REORDER_DISABLED_HINT, /Urutan Produk/);
});

// ---------------------------------------------------------------- moving rows

test('applyDrag: a row is lifted out and dropped at the target index', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => product(id));
  assert.deepEqual(ids(applyDrag(list, 0, 2)), ['b', 'c', 'a', 'd']); // down
  assert.deepEqual(ids(applyDrag(list, 3, 0)), ['d', 'a', 'b', 'c']); // to the top
  assert.deepEqual(ids(applyDrag(list, 1, 3)), ['a', 'c', 'd', 'b']); // to the bottom
  assert.deepEqual(ids(applyDrag(list, 2, 2)), ['a', 'b', 'c', 'd']); // onto itself
  assert.deepEqual(ids(applyDrag(list, 0, 9)), ['a', 'b', 'c', 'd']); // out of range
  assert.deepEqual(ids(applyDrag(list, -1, 1)), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd']); // never mutated
});

test('moveProduct: the keyboard equivalent, one step, clamped at both ends', () => {
  const list = ['a', 'b', 'c'].map((id) => product(id));
  assert.deepEqual(ids(moveProduct(list, 1, -1)), ['b', 'a', 'c']);
  assert.deepEqual(ids(moveProduct(list, 1, 1)), ['a', 'c', 'b']);
  assert.deepEqual(ids(moveProduct(list, 0, -1)), ['a', 'b', 'c']); // already first
  assert.deepEqual(ids(moveProduct(list, 2, 1)), ['a', 'b', 'c']); // already last
});

// ---------------------------------------------------------------- the request

test('reorderPayload: the complete list, in order, numbered 1..N', () => {
  const list = ['x', 'y', 'z'].map((id) => product(id, { sequence: 7 }));
  assert.deepEqual(reorderPayload(list), {
    items: [
      { id: 'x', sequence: 1 },
      { id: 'y', sequence: 2 },
      { id: 'z', sequence: 3 },
    ],
  });
  // A permutation of 1..N - what the server demands.
  const sequences = reorderPayload(list).items.map((i) => i.sequence);
  assert.deepEqual([...sequences].sort((a, b) => a - b), [1, 2, 3]);
});

test('sameOrder: nothing to send when nothing moved', () => {
  const list = ['a', 'b'].map((id) => product(id));
  assert.equal(sameOrder(list, [...list]), true);
  assert.equal(sameOrder(list, applyDrag(list, 0, 1)), false);
  assert.equal(sameOrder(list, [list[0]]), false);
});

// ---------------------------------------------------------------- the page

test('page: pagination is gone - the whole list is rendered', () => {
  assert.equal(/PAGE_SIZE/.test(PAGE), false);
  assert.equal(/pageCount|pageProducts|Sebelumnya|Berikutnya/.test(PAGE), false);
  assert.equal(/setPage\(/.test(PAGE), false);
  assert.match(PAGE, /Menampilkan \$\{rows\.length\} produk/);
  assert.match(PAGE, /\{rows\.map\(\(product: AdminProduct, index: number\) => \(/);
});

test('page: one source for the options and the ordering - no sort/status strings typed into the page', () => {
  assert.match(PAGE, /\{PRODUCT_SORT_OPTIONS\.map\(\(option\) => \(/);
  assert.match(PAGE, /\{PRODUCT_STATUS_FILTER_OPTIONS\.map\(\(option\) => \(/);
  assert.match(PAGE, /useState<ProductSortValue>\(DEFAULT_PRODUCT_SORT\)/);
  assert.match(PAGE, /sortProducts\(matching, sort\)/);
  assert.equal(/const sortOptions =|const statusOptions =/.test(PAGE), false);
  assert.equal(/'nameAsc'|'stockAsc'|'stockDesc'|'DRAFT'|'ARCHIVED'/.test(PAGE), false);
});

test('page: the drag handle needs Product.update AND a canonical, unfiltered list', () => {
  assert.match(PAGE, /const mayReorder = hasAllPermissions\(permissions, ROUTE_PERMISSIONS\.productUpdate\)/);
  assert.match(PAGE, /const reorderable = isReorderable\(\{ sort, search, statusFilter \}\)/);
  assert.match(PAGE, /const dragEnabled = mayReorder && reorderable/);
  assert.match(PAGE, /draggable=\{dragEnabled\}/);
  assert.match(PAGE, /disabled=\{!dragEnabled\}/);
  assert.match(PAGE, /aria-label=\{`Ubah urutan \$\{product\.name\}`\}/);
  assert.match(PAGE, /REORDER_DISABLED_HINT/);
  // Never send a reorder from a list where dragging is not allowed.
  assert.match(PAGE, /if \(!dragEnabled \|\| sameOrder\(rows, next\)\) return;/);
});

test('page: a drop saves through the reorder endpoint and reverts on failure', () => {
  assert.match(PAGE, /mutationFn: reorderAdminProducts/);
  assert.match(PAGE, /reorderMutation\.mutate\(reorderPayload\(next\)\.items\)/);
  assert.match(PAGE, /invalidateQueries\(\{ queryKey: \['admin-products'\] \}\)/);
  assert.match(PAGE, /onError: \(error\) => \{\s*setDraft\(null\);/); // the stored order wins
  assert.match(PAGE, /save\(applyDrag\(rows, dragIndex, to\)\)/);
  assert.match(PAGE, /save\(moveProduct\(rows, index, -1\)\)/); // keyboard
  assert.match(PAGE, /save\(moveProduct\(rows, index, 1\)\)/);
});

test('page: the filter/sort controls drop a pending local order instead of mixing it in', () => {
  assert.equal((PAGE.match(/resetDraft\(\);/g) ?? []).length, 3); // search, status, sort
  assert.match(PAGE, /const rows = draft \?\? products;/);
});

test('api: the reorder call is a PATCH to the reorder path; sequence is not a form field', () => {
  assert.match(API, /api<AdminProduct\[\]>\('\/admin\/catalog\/products\/reorder', \{\s*method: 'PATCH',/);
  assert.match(API, /export type AdminProductInput = Omit<Partial<AdminProduct>, 'images' \| 'sequence'> & \{ images\?: string\[\] \}/);
  assert.match(API, /sequence: number;/);
  // The product form never sends it.
  assert.equal(/sequence/.test(strip(read('app/products/components/product-form.tsx'))), false);
});

test('nothing else in the admin reorders products or lost its pagination', () => {
  for (const file of ['app/categories/page.tsx', 'app/banners/page.tsx', 'app/orders/page.tsx', 'app/shipping/page.tsx']) {
    assert.equal(/reorderAdminProducts|product-sequence/.test(read(file)), false, file);
  }
});
