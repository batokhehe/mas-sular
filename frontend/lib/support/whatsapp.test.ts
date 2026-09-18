import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildWhatsAppUrl, normalizeWhatsAppNumber, WHATSAPP_ARIA_LABEL, WHATSAPP_LABEL } from './whatsapp.ts'

/**
 * Floating WhatsApp support button. The URL logic is pure and tested directly; the
 * component and its placement are pinned in the source (this package has no
 * component-render harness).
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'))
const BUTTON = read('components/storefront/whatsapp-floating-button.tsx')
const SHELL = read('components/storefront/shell.tsx')

const NUMBER = '628811010452031'

test('a valid number is used as-is', () => {
  assert.equal(normalizeWhatsAppNumber(NUMBER), NUMBER)
  assert.equal(buildWhatsAppUrl(NUMBER), `https://wa.me/${NUMBER}`)
})

test('Indonesian 08... is converted to 62...', () => {
  assert.equal(normalizeWhatsAppNumber('08811010452031'), NUMBER)
  assert.equal(normalizeWhatsAppNumber('0811-2345-6789'), '6281123456789')
})

test('"+", spaces, dashes and parentheses are removed', () => {
  assert.equal(normalizeWhatsAppNumber('+62 881-1010-452031'), NUMBER)
  assert.equal(normalizeWhatsAppNumber(' +62 (881) 1010 452031 '), NUMBER)
})

test('the message is URL-encoded; a blank message adds no text parameter', () => {
  const message = 'Halo Kak, saya ingin bertanya mengenai Bakso Mas Sular.'
  assert.equal(buildWhatsAppUrl(NUMBER, message), `https://wa.me/${NUMBER}?text=${encodeURIComponent(message)}`)
  assert.equal(
    buildWhatsAppUrl(NUMBER, 'Harga & ongkir? 100% #promo'),
    `https://wa.me/${NUMBER}?text=Harga%20%26%20ongkir%3F%20100%25%20%23promo`,
  )
  assert.equal(buildWhatsAppUrl(NUMBER, '   '), `https://wa.me/${NUMBER}`)
  assert.equal(buildWhatsAppUrl(NUMBER, undefined), `https://wa.me/${NUMBER}`)
})

test('a missing number yields no URL (never wa.me/undefined)', () => {
  for (const missing of [undefined, null, '', '   ']) {
    assert.equal(buildWhatsAppUrl(missing, 'Halo'), null)
  }
})

test('an invalid number yields no URL', () => {
  for (const invalid of ['abc', '62811abc4520', '62.811.0101.45203', '12345', '6281101045203199999', '0', '+', 'javascript:alert(1)', '62811/../x']) {
    assert.equal(normalizeWhatsAppNumber(invalid), null, invalid)
    assert.equal(buildWhatsAppUrl(invalid), null, invalid)
  }
})

test('the component reads the number and message from env only, never a hardcoded number', () => {
  assert.match(BUTTON, /buildWhatsAppUrl\(process\.env\.NEXT_PUBLIC_WHATSAPP_NUMBER, process\.env\.NEXT_PUBLIC_WHATSAPP_MESSAGE\)/)
  assert.equal(BUTTON.includes(NUMBER), false)
  assert.equal(/wa\.me/.test(BUTTON), false, 'URL built only by the helper')
  assert.match(BUTTON, /if \(!WHATSAPP_URL\) return null/)
  assert.equal(/'use client'|"use client"/.test(BUTTON), false)
})

test('accessible, safe new-tab link with the label', () => {
  assert.equal(WHATSAPP_ARIA_LABEL, 'Chat WhatsApp dengan Bakso Mas Sular')
  assert.equal(WHATSAPP_LABEL, 'Butuh Bantuan Kak?')
  assert.match(BUTTON, /<a\s+href=\{WHATSAPP_URL\}\s+target="_blank"\s+rel="noopener noreferrer"\s+aria-label=\{WHATSAPP_ARIA_LABEL\}/)
  assert.match(BUTTON, /<span className="hidden text-xs font-semibold leading-none sm:inline">\{WHATSAPP_LABEL\}<\/span>/)
  assert.match(BUTTON, /<svg [^>]*aria-hidden="true"/)
  assert.match(BUTTON, /focus-visible:ring-4/)
})

test('placement: above the mobile bottom nav, 24px corner from md, reduced-motion aware, rendered once by the shell', () => {
  assert.match(BUTTON, /fixed right-4 bottom-\[calc\(4rem_\+_env\(safe-area-inset-bottom\)_\+_0\.75rem\)\] z-40/)
  assert.match(BUTTON, /md:right-6 md:bottom-6/)
  assert.match(BUTTON, /motion-safe:hover:scale-105 motion-safe:active:scale-95/)
  assert.equal(/animate-/.test(BUTTON), false, 'no continuous animation')
  assert.match(SHELL, /<StorefrontBottomNav \/>\s*<WhatsAppFloatingButton \/>/)
  // The bottom nav it clears is still 4rem tall and hidden from md.
  const nav = read('components/layout/storefront/bottom-nav.tsx')
  assert.match(nav, /fixed inset-x-0 bottom-0 z-40 [^"]*md:hidden/)
  assert.match(nav, /flex h-16 items-center/)
})
