import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * P2 #1 — the Category section is removed from the HOMEPAGE ONLY.
 *
 * The homepage "Kategori" strip was one self-contained component (CategoryStrip)
 * with its own GET /catalog/categories fetch. It is gone from the homepage; category
 * functionality itself is untouched: the catalog page keeps its own category fetch,
 * URL-driven `?category=` filter and chips, and the backend/Admin category APIs are
 * unchanged. There is no component-render harness in this package, so these guard
 * the source — both halves: the homepage no longer has it, the catalog still does.
 */

const ROOT = process.cwd() // `pnpm test` runs from the frontend package root
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const HOME = code(read('app/page.tsx'))

test('the homepage no longer renders or imports the Category section', () => {
  assert.equal(/CategoryStrip|category-strip/.test(HOME), false, 'homepage must not render the category strip')
  assert.equal(/Kategori/.test(HOME), false, 'no "Kategori" heading on the homepage')
})

test('the homepage performs no category fetch of its own', () => {
  assert.equal(/categories|qk\.catalog\.categories|\/catalog\/categories/.test(HOME), false)
})

test('every other homepage section is still rendered, in order', () => {
  // P2 #10 adds "Promo Spesial Produk" right after the voucher carousel; P2 #11 adds
  // "Trial Pack" right after that.
  const order = ['<HomeHero', '<BannerCarousel', '<PromoCarousel', 'title="Promo Spesial Produk"', 'title="Trial Pack"', 'title="Best Sellers"', 'title="New Arrivals"', 'title="All Products"']
  const positions = order.map((marker) => HOME.indexOf(marker))
  for (const [i, pos] of positions.entries()) assert.ok(pos >= 0, `homepage lost ${order[i]}`)
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'homepage section order changed')
})

test('the removed strip left no dangling import anywhere in the storefront', () => {
  assert.equal(existsSync(join(ROOT, 'components/storefront/category-strip.tsx')), false)
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (name === 'node_modules' || name === '.next') return []
      const full = join(dir, name)
      return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : []
    })
  const dangling = ['app', 'components', 'lib', 'hooks']
    .filter((d) => existsSync(join(ROOT, d)))
    .flatMap((d) => files(join(ROOT, d)))
    .filter((f) => /category-strip|CategoryStrip/.test(code(readFileSync(f, 'utf8'))))
    .map((f) => relative(ROOT, f))
  assert.deepEqual(dangling, [])
})

test('category functionality OUTSIDE the homepage is preserved (catalog page + API client)', () => {
  const catalog = code(read('app/catalog/page.tsx'))
  assert.match(catalog, /productsApi\.categories/, 'catalog page still fetches categories')
  assert.match(catalog, /sp\.get\('category'\)/, 'catalog page still reads the ?category= URL filter')
  assert.match(catalog, /setCategory\(c\.slug\)/, 'catalog page still renders a chip per category')
  assert.match(code(read('lib/api/products.api.ts')), /categories:\s*\(\)\s*=>\s*api\.get<Category\[\]>\('\/catalog\/categories'\)/)
})
