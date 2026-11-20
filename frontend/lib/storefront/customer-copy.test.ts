import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Customer-facing wording: "Tambahkan" on the add-to-cart buttons, "Tambahan" for
 * what used to be labelled "Topping". Internal identifiers and the API contract
 * (toppings, topping_ids, /catalog/toppings) are deliberately unchanged.
 */
const ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

/** Storefront pages/components (the in-repo admin panel under app/admin is not customer-facing). */
function storefrontSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(ROOT, full)
      if (rel.startsWith(join('app', 'admin'))) continue
      if (statSync(full).isDirectory()) walk(full)
      else if (full.endsWith('.tsx')) out.push(rel)
    }
  }
  walk(join(ROOT, 'app'))
  walk(join(ROOT, 'components'))
  return out
}

test('add-to-cart buttons say "Tambahkan"', () => {
  assert.match(read('components/storefront/product-card.tsx'), /canAdd \? 'Tambahkan' : 'Stok di keranjang penuh'/)
  assert.match(read('app/catalog/[slug]/page.tsx'), /`Tambahkan · \$\{formatIDR\(unitPrice \* qty\)\}`/)
  for (const file of storefrontSources()) {
    assert.doesNotMatch(read(file), /Tambah(kan)? ke [Kk]eranjang/, file)
  }
})

test('no customer-visible "Topping" text remains; "Tambahan" is used instead', () => {
  assert.match(read('app/catalog/[slug]/page.tsx'), /Tambahan <span className="text-sm font-normal text-muted-foreground">\(opsional\)<\/span>/)
  assert.match(read('app/invoice/[token]/page.tsx'), /Tambahan: \{item\.toppings\.map/)
  for (const file of storefrontSources()) {
    const code = read(file)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // JSX text or a string literal containing the word - not identifiers like toppingIds.
    assert.doesNotMatch(code, />[^<{}]*\bTopping\b[^<]*</, `${file}: visible "Topping" text`)
    assert.doesNotMatch(code, /['"`][^'"`\n]*\bTopping\b[^'"`\n]*['"`]/, `${file}: "Topping" in a string`)
  }
})

test('internal identifiers and API contract are unchanged', () => {
  assert.match(read('lib/api/products.api.ts'), /toppings: \(\) => api\.get<Topping\[\]>\('\/catalog\/toppings'\)/)
  assert.match(read('lib/validation/checkout.schema.ts'), /topping_ids: z\.array\(z\.string\(\)\)\.optional\(\)/)
})

test('checkout success no longer promises an email that is not sent', () => {
  assert.doesNotMatch(read('app/checkout/success/page.tsx'), /ke email Anda/)
})
