import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * P2 #3 — storefront brand copy in the homepage hero.
 *
 * The hero copy is hardcoded in components/storefront/home-hero.tsx (no API, env or
 * CMS value feeds it) and is prerendered into the HTML at `next build`, so a copy
 * change only reaches the storefront through a rebuilt image AND a recreated
 * container. These guard the source copy; there is no component-render harness here.
 */

const ROOT = process.cwd() // `pnpm test` runs from the frontend package root
const HERO = readFileSync(join(ROOT, 'components/storefront/home-hero.tsx'), 'utf8')
const HOME = readFileSync(join(ROOT, 'app/page.tsx'), 'utf8')

const HEADLINE = 'Bakso Bumbu Rujak Favorit Keluarga'
const DESCRIPTION = 'Gak pake kuah, Bakso mas sular hadir dengan sensasi kenikmatan yang beda, gak gitu aja.'

/** Visible text of the first <tag>…</tag>: inner tags dropped, whitespace collapsed. */
function textOf(tag: string): string {
  const m = HERO.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))
  assert.ok(m, `hero has no <${tag}>`)
  return m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

test('the hero headline is exactly the design copy', () => {
  assert.equal(textOf('h1'), HEADLINE)
})

test('the second headline phrase keeps its brand accent', () => {
  assert.match(HERO, /<span className="text-primary">Favorit Keluarga<\/span>/)
})

test('the hero description is exactly the design copy', () => {
  assert.equal(textOf('p'), DESCRIPTION)
})

test('none of the earlier hero copy is left behind', () => {
  for (const old of ['Bakso Premium', 'Asli Nusantara', 'Nikmati kelezatan', 'gak gitu gitu aja']) {
    assert.equal(HERO.includes(old), false, `stale hero copy: "${old}"`)
  }
})

test('the hero layout and CTAs are unchanged', () => {
  assert.match(HERO, /<h1 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl lg:text-5xl">/)
  assert.match(HERO, /<p className="mx-auto mt-4 max-w-lg text-pretty text-muted-foreground lg:mx-0">/)
  assert.match(HERO, /Pesan Sekarang/)
  assert.match(HERO, /Lihat Menu/)
  assert.equal(HERO.match(/href="\/catalog"/g)?.length, 2, 'both CTAs still link to /catalog')
})

test('the homepage still renders the hero first', () => {
  assert.ok(HOME.includes('<HomeHero />'))
  assert.ok(HOME.indexOf('<HomeHero') < HOME.indexOf('<BannerCarousel'))
})
