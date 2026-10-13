import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeRedirect } from './safe-redirect.ts'

/**
 * Production-readiness H3 — open redirect on /login and /onboarding.
 *
 * `/login?redirect=%2F%5Cevil.example` reached router.replace('/\evil.example'),
 * which the browser resolves to //evil.example and navigates off-site. Special
 * characters are built with String.fromCharCode so the test source itself stays
 * unambiguous.
 */
const BS = String.fromCharCode(92) // backslash
const TAB = String.fromCharCode(9)
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)
const NUL = String.fromCharCode(0)
const DEL = String.fromCharCode(127)

test('legitimate internal redirects are preserved', () => {
  assert.equal(safeRedirect('/'), '/')
  assert.equal(safeRedirect('/checkout'), '/checkout')
  assert.equal(safeRedirect('/account/orders'), '/account/orders')
  assert.equal(safeRedirect('/catalog/foo'), '/catalog/foo')
  assert.equal(safeRedirect('/checkout?step=2#pay'), '/checkout?step=2#pay')
  assert.equal(safeRedirect('/catalog/baso%20urat'), '/catalog/baso%20urat')
  assert.equal(safeRedirect('/account/addresses?returnTo=checkout'), '/account/addresses?returnTo=checkout')
})

const REJECTED: Array<[string, string | null | undefined]> = [
  ['protocol-relative', '//evil.example'],
  ['backslash host (the confirmed exploit)', `/${BS}evil.example`],
  ['double backslash', `/${BS}${BS}evil.example`],
  ['backslash later in the path', `/checkout${BS}..${BS}evil`],
  ['percent-encoded backslash', '/%5Cevil.example'],
  ['percent-encoded backslash, lower case', '/%5cevil.example'],
  ['percent-encoded second slash', '/%2F/evil.example'],
  ['dot-segments that normalize to //host', '/..//evil.example'],
  ['single-dot segment that normalizes to //host', '/.//evil.example'],
  ['encoded dot-segments that normalize to //host', '/%2e%2e//evil.example'],
  ['absolute https URL', 'https://evil.example'],
  ['absolute http URL', 'http://evil.example'],
  ['javascript: URL', 'javascript:alert(document.cookie)'],
  ['data: URL', 'data:text/html,hi'],
  ['relative path without leading slash', 'checkout'],
  ['leading space', ' /checkout'],
  ['tab after the slash', `/${TAB}/evil.example`],
  ['newline after the slash', `/${LF}/evil.example`],
  ['carriage return', `/checkout${CR}`],
  ['NUL', `/checkout${NUL}`],
  ['DEL', `/checkout${DEL}`],
  ['percent-encoded tab', '/%09/evil.example'],
  ['malformed percent-encoding', '/%E0%A4%A'],
  ['lone percent', '/%'],
  ['empty', ''],
  ['null', null],
  ['undefined', undefined],
  ['over-long', `/${'a'.repeat(3000)}`],
]

for (const [label, value] of REJECTED) {
  test(`rejected: ${label}`, () => {
    assert.equal(safeRedirect(value), '/')
  })
}

test('a rejected value falls back to the caller-supplied fallback', () => {
  assert.equal(safeRedirect(`/${BS}evil.example`, '/account'), '/account')
})

test('nothing accepted can leave the origin (property check over the rejected set + a sweep)', () => {
  const base = 'https://shop.example.invalid'
  const candidates = [...REJECTED.map(([, v]) => v ?? ''), '/', '/checkout', '/%2e%2e/%2e%2e/etc', '/..//evil.example', '/./evil']
  for (const c of candidates) {
    const target = new URL(safeRedirect(c), base)
    assert.equal(target.origin, base, `left the origin for ${JSON.stringify(c)}`)
  }
})

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'))

test('login and onboarding both use the shared guard and keep no private copy', () => {
  for (const page of ['app/login/page.tsx', 'app/onboarding/page.tsx']) {
    const src = read(page)
    assert.match(src, /import \{ safeRedirect \} from '@\/lib\/auth\/safe-redirect'/, `${page} imports the shared guard`)
    assert.equal(/function safeRedirect/.test(src), false, `${page} has no local safeRedirect`)
  }
  assert.match(read('app/login/page.tsx'), /const redirect = safeRedirect\(params\.get\('redirect'\)\)/)
  assert.match(read('app/onboarding/page.tsx'), /router\.replace\(safeRedirect\(redirect\)\)/)
})
