import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactCapabilityUrl, redactInvoiceUrl } from './redact-url.ts'
import { orderStatusLabel, paymentMethodLabel, paymentStatusLabel, shipmentStatusLabel } from './labels.ts'

/**
 * P2 #14 — public customer invoice page (/invoice/<token>).
 *
 * Pure helpers are tested directly; the page wiring is pinned in the source (no
 * component-render harness exists here). Token validation, scoping and the
 * customer-safe payload are enforced and tested by the backend.
 */

const strip = (src: string) => src.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const read = (p: string) => strip(readFileSync(join(process.cwd(), p), 'utf8'))
const PAGE = read('app/invoice/[token]/page.tsx')
const LAYOUT = read('app/invoice/[token]/layout.tsx')
const API = read('lib/api/invoices.api.ts')
const ROOT = read('app/layout.tsx')
const ANALYTICS = read('components/analytics.tsx')

const TOKEN = 'e'.repeat(64)

test('analytics URLs lose the invoice token (and nothing else)', () => {
  assert.equal(redactInvoiceUrl(`https://shop.example/invoice/${TOKEN}`), 'https://shop.example/invoice/[redacted]')
  assert.equal(redactInvoiceUrl(`https://shop.example/invoice/${TOKEN}?print=1`), 'https://shop.example/invoice/[redacted]?print=1')
  assert.equal(redactInvoiceUrl('https://shop.example/catalog/baso'), 'https://shop.example/catalog/baso')
})

test('the root layout reports page views only through the redacting wrapper', () => {
  assert.match(ROOT, /<SiteAnalytics \/>/)
  assert.equal(/<Analytics\b/.test(ROOT), false, 'no un-redacted <Analytics /> left')
  assert.match(ANALYTICS, /<Analytics beforeSend=\{beforeSend\} \/>/)
  // H4 widened the wrapper to every capability-token page (invoice + payment upload).
  assert.match(ANALYTICS, /url: redactCapabilityUrl\(event\.url\)/)
})

test('H4: analytics URLs also lose the payment-upload token, and only a real token', () => {
  const PAY = 'a1'.repeat(32)
  assert.equal(redactCapabilityUrl(`https://shop.example/payment/${PAY}`), 'https://shop.example/payment/[redacted]')
  assert.equal(redactCapabilityUrl(`https://shop.example/payment/${PAY}?x=1`), 'https://shop.example/payment/[redacted]?x=1')
  assert.equal(redactCapabilityUrl(`https://shop.example/invoice/${TOKEN}`), 'https://shop.example/invoice/[redacted]')
  for (const fixed of ['success', 'failed', 'pending', 'gateway']) {
    assert.equal(redactCapabilityUrl(`https://shop.example/payment/${fixed}`), `https://shop.example/payment/${fixed}`)
  }
  assert.equal(redactCapabilityUrl('https://shop.example/catalog/baso'), 'https://shop.example/catalog/baso')
})

test('14. customer-facing labels follow the business statuses', () => {
  assert.equal(paymentStatusLabel('PAID'), 'Lunas')
  assert.equal(paymentStatusLabel('PENDING'), 'Belum dibayar')
  assert.equal(paymentStatusLabel('WAITING_VERIFICATION'), 'Menunggu verifikasi')
  assert.equal(paymentMethodLabel('BANK_TRANSFER'), 'Transfer bank')
  assert.equal(orderStatusLabel('CANCELLED'), 'Dibatalkan')
  assert.equal(shipmentStatusLabel('IN_TRANSIT'), 'Dalam perjalanan')
  assert.equal(paymentStatusLabel('SOMETHING_NEW'), 'SOMETHING_NEW') // never hides an unknown status
  assert.equal(paymentStatusLabel(null), '-')
})

test('8. the page is public: no login guard, no customer session, no storefront chrome', () => {
  assert.equal(/RequireAuth|useMe|useAuth|StorefrontShell/.test(PAGE + LAYOUT), false)
  assert.match(API, /api\.get<CustomerInvoice>\(`\/invoices\/\$\{encodeURIComponent\(token\)\}`, 'public'\)/)
})

test('the token is sent to the API only - never rendered on the page', () => {
  assert.match(PAGE, /queryFn: \(\) => invoicesApi\.get\(token\)/)
  const jsx = PAGE.split('return (').slice(1).join('return (')
  assert.equal(/\{token\}|\{params|token\.slice|\$\{token/.test(jsx), false)
})

test('the link stays out of search engines and is never sent on as a Referer', () => {
  assert.match(LAYOUT, /robots: \{ index: false, follow: false \}/)
  assert.match(LAYOUT, /referrer: 'no-referrer'/)
})

test('invalid / expired links show a safe message with no detail about why', () => {
  assert.match(PAGE, /if \(isError \|\| !data\) return <InvoiceUnavailable \/>/)
  assert.match(PAGE, /Link invoice tidak tersedia/)
  assert.match(PAGE, /retry: false/)
})

test('16. printing prints the invoice only: controls are hidden, ?print=1 prints once after loading', () => {
  assert.match(PAGE, /<div className="mb-4 flex justify-end print:hidden">/)
  assert.match(PAGE, /print:border-0/)
  assert.match(PAGE, /useSearchParams\(\)\.get\('print'\) === '1'/)
  assert.match(PAGE, /if \(data && printRequested && !printed\.current\) \{\s*printed\.current = true/)
  assert.match(PAGE, /onClick=\{\(\) => window\.print\(\)\}/)
})

test('11-13/15. the page renders the backend invoice values as-is (no client-side money math)', () => {
  for (const field of ['item.quantity', 'formatIDR(item.unitPrice)', 'formatIDR(item.lineTotal)', 'formatIDR(invoice.subtotal)', 'formatIDR(invoice.shippingCost)', 'formatIDR(invoice.total)', 'delivery.recipientName', 'delivery.phone', 'delivery.address', 'shipping.trackingNumber', 'paymentStatusLabel(payment.status)']) {
    assert.ok(PAGE.includes(field), `renders ${field}`)
  }
  assert.equal(/reduce\(|\*\s*item\.quantity/.test(PAGE), false, 'no totals computed in the browser')
})

test('"Biaya Layanan" follows the backend flag, so a gateway invoice shows it even at Rp0', () => {
  assert.match(PAGE, /\(invoice\.paymentServiceFeeApplies \?\? invoice\.paymentServiceFee > 0\) \?/)
  assert.match(PAGE, /<Row label="Biaya Layanan" value=\{formatIDR\(invoice\.paymentServiceFee\)\} \/>/)
  assert.match(API, /paymentServiceFeeApplies\?: boolean/)
  // Only the customer-charged fee exists on the customer contract - never the merchant's share.
  assert.equal(/Absorbed|Calculated|serviceFeeRule/.test(API + PAGE), false)
})

test('narrow screens: long values wrap instead of overflowing', () => {
  assert.ok((PAGE.match(/\[overflow-wrap:anywhere\]/g) ?? []).length >= 4)
  assert.match(PAGE, /<div className="min-w-0">/)
})
