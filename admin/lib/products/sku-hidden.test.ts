import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * P2 #5 — the Admin must never show a product SKU: not in the product list, not in
 * the create/edit form, not under order line items, not as a search hint.
 *
 * There is no component-render harness in this package, so this guards the source:
 * no Admin file may read `.sku` or render a "SKU" label. Comments are stripped first,
 * so explanatory notes are allowed. `AdminProduct` has no `sku` field, so a
 * regression also fails to compile. The backend still stores and assigns SKU (it is
 * the Paxel item code) — it is only never rendered.
 */

const ROOT = process.cwd(); // `pnpm test` runs from the admin package root
const SCANNED = ['app', 'components', 'lib'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no Admin source reads a product SKU or renders a "SKU" label', () => {
  const offenders = SCANNED.flatMap((d) => {
    try {
      return sourceFiles(join(ROOT, d));
    } catch {
      return [];
    }
  })
    .filter((file) => /\.sku\b|\bsku\s*[:?]|>\s*SKU\b|['"`]SKU\b|\bSKU,/i.test(withoutComments(readFileSync(file, 'utf8'))))
    .map((file) => relative(ROOT, file));
  assert.deepEqual(offenders, [], `SKU must not be exposed in the Admin: ${offenders.join(', ')}`);
});

test('the Admin product form no longer carries a sku value', () => {
  const form = withoutComments(readFileSync(join(ROOT, 'app/products/components/product-form.tsx'), 'utf8'));
  assert.equal(/\bsku\b/i.test(form), false);
});

test('the Admin product search hint no longer mentions SKU', () => {
  const list = withoutComments(readFileSync(join(ROOT, 'app/products/page.tsx'), 'utf8'));
  assert.equal(/SKU/i.test(list), false);
});
