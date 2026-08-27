import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerLogoSrc } from './provider-logo-assets.ts'

test('resolves the supplied Paxel logo from the provider id', () => {
  assert.equal(providerLogoSrc('paxel'), '/paxel-logo.jpeg')
  assert.equal(providerLogoSrc('PAXEL'), '/paxel-logo.jpeg')
})

test('resolves the supplied JNE logo from the provider id', () => {
  assert.equal(providerLogoSrc('jne'), '/jne-logo.jpg')
  assert.equal(providerLogoSrc('JNE'), '/jne-logo.jpg')
})

test('leaves an unknown provider on the component fallback path', () => {
  assert.equal(providerLogoSrc('sicepat'), undefined)
})
