import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paymentVerificationNotice, VERIFICATION_NOTICE_TEXT } from './verification-notice.ts'

const ROOT = join(import.meta.dirname, '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ')

test('the approved wording', () => {
  assert.equal(VERIFICATION_NOTICE_TEXT, 'Pembayaranmu sedang diverifikasi. Mohon tunggu konfirmasi admin melalui Whatsapp')
})

test('the admin number comes from the configured value, normalized, with a wa.me link', () => {
  assert.deepEqual(paymentVerificationNotice('0811-2233-4455'), {
    text: VERIFICATION_NOTICE_TEXT,
    phone: '+6281122334455',
    whatsappUrl: 'https://wa.me/6281122334455',
  })
  assert.equal(paymentVerificationNotice('+62 811 2233 4455').phone, '+6281122334455')
})

test('missing or invalid configuration: the sentence alone, never a guessed number', () => {
  for (const raw of [undefined, null, '', 'abc', '123']) {
    assert.deepEqual(paymentVerificationNotice(raw), { text: VERIFICATION_NOTICE_TEXT, phone: null, whatsappUrl: null })
  }
})

test('shown after every receipt upload, reading NEXT_PUBLIC_WHATSAPP_NUMBER (no hardcoded number)', () => {
  const component = read('components/storefront/payment-verification-notice.tsx')
  assert.match(component, /paymentVerificationNotice\(process\.env\.NEXT_PUBLIC_WHATSAPP_NUMBER\)/)
  assert.doesNotMatch(component, /\d{9,}/, 'no phone number in the source')
  for (const file of ['components/storefront/upload-receipt.tsx', 'app/payment/success/page.tsx']) {
    assert.match(read(file), /<PaymentVerificationNotice className="text-sm text-muted-foreground" \/>/, file)
  }
})
