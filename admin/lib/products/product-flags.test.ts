import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P2 #10 (Promo Special) and P2 #11 (Trial Pack) — the Admin can mark / unmark a
 * product for each homepage section.
 *
 * No component-render harness exists in this package, so this pins the form wiring
 * in the source; persistence is proven against PostgreSQL in the backend
 * product-flags.int-spec.ts and in the browser (see the #10 / #11 reports).
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'));
const FORM = read('app/products/components/product-form.tsx');
const LIST = read('app/products/page.tsx');
const TYPES = read('lib/admin.ts');

const FLAGS = [
  { field: 'isPromoSpecial', label: 'Promo Special' },
  { field: 'isTrialPack', label: 'Trial Pack' },
] as const;

for (const { field, label } of FLAGS) {
  test(`${field}: the product type and the form values carry it as a boolean`, () => {
    assert.match(TYPES, new RegExp(`${field}: boolean;`));
    assert.match(FORM, new RegExp(`export type ProductFormValues = \\{[\\s\\S]*?${field}: boolean;[\\s\\S]*?\\};`));
  });

  test(`${field}: the edit form starts from the persisted value; a new product starts unchecked`, () => {
    assert.match(FORM, new RegExp(`${field}: initialValues\\?\\.${field} \\?\\? false,`));
  });

  test(`${field}: a "${label}" checkbox toggles it in the submitted values`, () => {
    const box = FORM.match(new RegExp(`<input\\s+type="checkbox"\\s+checked=\\{values\\.${field}\\}[\\s\\S]*?\\/>\\s*${label}\\s*<\\/label>`));
    assert.ok(box, `${label} checkbox bound to values.${field}`);
    assert.match(box[0], new RegExp(`onChange=\\{\\(event\\) => handleChange\\('${field}', event\\.target\\.checked\\)\\}`));
  });

  test(`${field}: the product list shows a "${label}" badge for flagged products`, () => {
    assert.match(LIST, new RegExp(`\\{product\\.${field} \\? \\(\\s*<Badge tone="brand" className="ml-2">\\s*${label}\\s*<\\/Badge>\\s*\\) : null\\}`));
  });
}

test('both checkboxes live in the existing Flags group, next to Best seller and New', () => {
  const flags = FORM.split('<span>Flags</span>')[1]?.split('</div>')[0] ?? '';
  for (const label of ['Best seller', 'New', 'Promo Special', 'Trial Pack']) {
    assert.ok(new RegExp(`/>\\s*${label}\\s*</label>`).test(flags), `${label} in the Flags group`);
  }
});

test('create and edit submit the whole form values (so both flags reach the API)', () => {
  const create = read('app/products/new/page.tsx');
  const edit = read('app/products/[id]/page.tsx');
  // P2: the ordered gallery (images[] + its cover as imageUrl) is spread in too.
  assert.match(FORM, /await onSubmit\(\{ \.\.\.values, \.\.\.gallery, \.\.\.toPhysicalPayload\(physical\) \}\)/);
  assert.match(create, /mutationFn: \(input: ProductFormValues\) => createAdminProduct\(input\)/);
  assert.match(edit, /updateAdminProduct\(id, input\)/);
  assert.match(edit, /initialValues=\{productQuery\.data\}/);
});

test('no SKU anywhere in the product form or list (#5)', () => {
  assert.equal(/\.sku\b|SKU/.test(LIST + FORM), false);
});
