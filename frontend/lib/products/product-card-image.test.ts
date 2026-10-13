import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #4 — a product's source image must never decide the ProductCard's size.
 *
 * Measured before the fix (catalog grid): the image box was `aspect-square` but the
 * <img> sat IN FLOW, so a portrait source (300x900) pushed its "square" box to
 * 266x798 at 1280px wide; the card became 944px tall and the grid row stretched all
 * three neighbours to 944px too (normal: 436). Same at 768px (838 vs 401) and 375px
 * (631 vs 332). After: every box is square at every breakpoint for 48x48, 900x300,
 * 300x900 and 2400x2400 sources alike.
 *
 * No component-render harness exists in this package, so this pins the cause in the
 * source; the rendered geometry was verified in the browser (see the #4 report).
 */

const SRC = readFileSync(join(process.cwd(), 'components/storefront/product-card.tsx'), 'utf8')
const code = SRC.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const boxClass = (code.match(/<Link href=\{`\/catalog\/\$\{product\.slug\}`\} className="([^"]*aspect-[^"]*)"/) ?? [])[1] ?? ''
const imgClass = (code.match(/<img[^>]*className="([^"]+)"/) ?? [])[1] ?? ''
const has = (cls: string, token: string) => cls.split(/\s+/).includes(token)

test('the image area is a square that clips its contents', () => {
  assert.ok(boxClass, 'image container not found')
  for (const t of ['relative', 'aspect-square', 'overflow-hidden']) assert.ok(has(boxClass, t), `image box missing ${t}`)
})

test('the <img> is out of flow, so its intrinsic size cannot size the box or the card', () => {
  assert.ok(imgClass, '<img> not found')
  for (const t of ['absolute', 'inset-0', 'size-full']) assert.ok(has(imgClass, t), `img missing ${t}`)
})

test('images fill the square without distortion (object-fit, never stretched)', () => {
  assert.ok(has(imgClass, 'object-cover') || has(imgClass, 'object-contain'), 'img needs an object-fit')
  assert.equal(/object-fill/.test(imgClass), false, 'object-fill would distort non-square sources')
})

test('everything else on the card is preserved', () => {
  assert.match(code, /href=\{`\/catalog\/\$\{product\.slug\}`\}/, 'navigation to the product')
  assert.match(code, /src=\{product\.imageUrl\}\s+alt=\{product\.name\}/, 'image source + alt text')
  for (const marker of ['Terlaris', '>Baru<', 'variant="destructive"', 'Level pedas', 'formatIDR(product.price)', 'formatIDR(product.originalPrice)', 'add(product)', 'Stok Habis', 'Tambah ke Keranjang']) {
    assert.ok(code.includes(marker), `lost: ${marker}`)
  }
})
