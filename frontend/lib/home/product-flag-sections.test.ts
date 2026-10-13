import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #10 "Promo Spesial Produk" and P2 #11 "Trial Pack" — homepage product
 * sections driven by product flags, distinct from the voucher section "Promo Spesial".
 *
 * No component-render harness exists in this package, so this pins the wiring in
 * the source; the rendered sections are verified in the browser (see the reports).
 * The backend filters and their visibility rules are tested against PostgreSQL.
 */

const code = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => code(readFileSync(join(process.cwd(), p), 'utf8'))
const HOME = read('app/page.tsx')
const API = read('lib/api/products.api.ts')
const TYPES = read('lib/types/models.ts')
const PROMO_CAROUSEL = read('components/storefront/promo-carousel.tsx')
const SECTION = read('components/storefront/product-section.tsx')

const SECTIONS = [
  { title: 'Promo Spesial Produk', param: 'promoSpecial', field: 'isPromoSpecial', list: 'promoSpecial' },
  { title: 'Trial Pack', param: 'trialPack', field: 'isTrialPack', list: 'trialPack' },
] as const

for (const s of SECTIONS) {
  test(`"${s.title}": rendered as its own product section`, () => {
    assert.match(HOME, new RegExp(`<ProductSection title="${s.title}" products=\\{${s.list}\\} \\/>`))
  })

  test(`"${s.title}": loaded by the ${s.field} flag (server-side filter), only flagged products shown`, () => {
    assert.match(HOME, new RegExp(`const ${s.list}Query = useProducts\\(\\{ ${s.param}: true \\}\\)`))
    assert.match(HOME, new RegExp(`\\(${s.list}Query\\.data \\?\\? \\[\\]\\)\\.filter\\(\\(p\\) => p\\.${s.field}\\)`))
    assert.match(API, new RegExp(`${s.param}\\?: boolean`))
    assert.match(TYPES, new RegExp(`${s.field}: boolean`))
  })
}

test('no hard-coded products anywhere on the homepage', () => {
  assert.equal(/slug ===|id ===|['"][0-9a-f]{8}-[0-9a-f]{4}-/.test(HOME), false)
  assert.match(API, /list: \(q: ProductQuery = \{\}\) => api\.get<Product\[\]>\(`\/catalog\/products\$\{buildQuery\(q\)\}`\)/)
})

test('16. a section with no eligible products does not render (no empty heading)', () => {
  assert.match(SECTION, /if \(products\.length === 0\) return null/)
})

test('Trial Pack sits right after Promo Spesial Produk; the three promo headings never collide', () => {
  assert.ok(HOME.indexOf('title="Promo Spesial Produk"') < HOME.indexOf('title="Trial Pack"'))
  assert.ok(HOME.indexOf('title="Trial Pack"') < HOME.indexOf('title="Terlaris"'))
  assert.match(PROMO_CAROUSEL, /<h2 className="mb-4 text-xl font-bold">Promo Spesial<\/h2>/)
  assert.equal(/Promo Spesial Produk|Trial Pack/.test(PROMO_CAROUSEL), false)
})

test('18. the voucher / promo-code section is still rendered from the promos API', () => {
  assert.match(HOME, /<PromoCarousel \/>/)
  assert.match(PROMO_CAROUSEL, /queryFn:\s*productsApi\.promos/)
})

test('20/21. both sections reuse ProductSection -> ProductCard (#4 square images, #5 no SKU)', () => {
  assert.match(SECTION, /<ProductCard key=\{p\.id\} product=\{p\} \/>/)
  assert.match(SECTION, /grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4/)
  assert.equal(/sku/i.test(HOME), false)
})

test('19. no Category section returns to the homepage (#1)', () => {
  assert.equal(/CategoryStrip|Kategori|categories/.test(HOME), false)
})
