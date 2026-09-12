import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #2 — homepage promo cards: compact, equal size, text wraps.
 *
 * The cards were `aspect-[16/9]` flex items with only a `min-w-*`, so each card was
 * as WIDE as its longest unwrapped line and 16:9 made it as TALL as that width; the
 * row then stretched every card to the tallest one. Measured before the fix: one
 * long promo made all four cards 782px tall (at 1280px and at 375px wide).
 *
 * No component-render harness exists in this package, so this pins the causes in the
 * source; the rendered geometry was verified in the browser (see the #2 report).
 */

const SRC = readFileSync(join(process.cwd(), 'components/storefront/promo-carousel.tsx'), 'utf8')
const code = SRC.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
const cardClass = (code.match(/key=\{promo\.id\}\s*className="([^"]+)"/) ?? [])[1] ?? ''

test('a card is not sized by an aspect ratio (height must not follow width)', () => {
  assert.ok(cardClass, 'promo card className not found')
  assert.equal(/aspect-/.test(cardClass), false)
})

test('card width is explicit and responsive, never driven by its text', () => {
  assert.equal(/min-w-\[/.test(cardClass), false, 'min-width alone lets long text widen the card')
  for (const w of ['w-[85%]', 'sm:w-[calc((100%-1rem)/2)]', 'lg:w-[calc((100%-2rem)/3)]', 'shrink-0']) {
    assert.ok(cardClass.split(/\s+/).includes(w), `missing ${w}`)
  }
})

test('title and description wrap inside the card and are capped so cards stay equal', () => {
  const title = (code.match(/<h3[\s\S]*?className="([^"]+)"/) ?? [])[1] ?? ''
  const desc = (code.match(/<p title=\{promo\.description\}\s*className="([^"]+)"/) ?? [])[1] ?? ''
  for (const cls of [title, desc]) {
    assert.ok(cls.includes('line-clamp-2'), `expected a 2-line cap in "${cls}"`)
    assert.ok(cls.includes('[overflow-wrap:anywhere]'), `expected long words to wrap in "${cls}"`)
  }
  // The full text stays reachable when a line cap applies.
  assert.match(code, /title=\{promo\.title\}/)
  assert.match(code, /title=\{promo\.description\}/)
})

test('promo content, data source and empty-state behaviour are preserved', () => {
  assert.match(code, /queryKey:\s*\['catalog',\s*'promos'\]/)
  assert.match(code, /queryFn:\s*productsApi\.promos/)
  assert.match(code, /if \(promos\.length === 0\) return null/)
  assert.match(code, /Promo Spesial/)
  for (const field of ['promo.code', 'promo.title', 'promo.description']) assert.ok(code.includes(`{${field}}`), `still renders ${field}`)
})
