import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single stock interface: Admin -> Produk manages product information only; stock
 * is viewed and managed ONLY in Stok Produk (ProductInventory). The Product list,
 * the create/edit form and its payload carry no stock - not hidden, absent - so a
 * product edit can never send a stale or default stock. The backend also ignores
 * any `stock` sent to the product endpoints.
 *
 * There is no component-render harness in this package, so this guards the source
 * (comments stripped first). `AdminProduct` has no `stock` field, so reading it in
 * the Product UI also fails to compile.
 */
const ROOT = process.cwd(); // `pnpm test` runs from the admin package root
const withoutComments = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => withoutComments(readFileSync(join(ROOT, p), 'utf8'));

const PRODUCT_UI = [
  'app/products/page.tsx',
  'app/products/new/page.tsx',
  'app/products/[id]/page.tsx',
  'app/products/components/product-form.tsx',
  'lib/products/product-sequence.ts',
];

test('the Product menu never reads, renders, sorts by or submits stock', () => {
  for (const file of PRODUCT_UI) {
    const src = read(file);
    assert.equal(/\bstock\b/i.test(src), false, `${file} mentions stock`);
    assert.equal(/>\s*Stok\s*</.test(src), false, `${file} renders a "Stok" label`);
    assert.equal(/stockAsc|stockDesc/.test(src), false, `${file} has a stock sort`);
  }
});

test('the Product menu points to Stok Produk instead', () => {
  assert.match(read('app/products/page.tsx'), /Stok dikelola di menu Stok Produk/);
  assert.match(read('app/products/[id]/page.tsx'), /Stok dikelola di menu Stok Produk/);
});

test('AdminProduct (and so AdminProductInput, the create/update payload type) has no stock field', () => {
  const api = read('lib/admin.ts');
  const start = api.indexOf('export type AdminProduct = {');
  assert.ok(start >= 0);
  const block = api.slice(start, api.indexOf('};', start));
  assert.equal(/\bstock\b/.test(block), false);
  assert.match(api, /export type AdminProductInput = Omit<Partial<AdminProduct>,/);
});

test('Stok Produk keeps its stock table and the ProductInventory.update-gated adjustment', () => {
  const page = read('app/inventory/products/page.tsx');
  assert.match(page, /adjustStock\(\{ productId: row\.productId, outletId: row\.outletId, stock: Number\(value\) \}\)/);
  assert.match(page, /<PermissionGate permissions=\{ROUTE_PERMISSIONS\.productInventoryUpdate\}>/);
  for (const label of ['Stok', 'Direservasi', 'Tersedia']) assert.match(page, new RegExp(`>${label}<`));
  assert.match(read('lib/access.ts'), /productInventoryUpdate: \['ProductInventory\.update'\]/);
});
