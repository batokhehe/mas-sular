/**
 * P2 #14: the customer invoice page lives at /invoice/<token>, and that token is
 * the only credential for it. Anything that reports page URLs (analytics) must
 * send the path without it.
 */
const INVOICE_TOKEN_PATH = /(\/invoice\/)[^/?#]+/g

/**
 * Production-readiness H4: the payment-receipt upload page, /payment/<token>, is the
 * same kind of capability link (the link in the customer's WhatsApp/email). Only a
 * 64-hex token segment is redacted, so the fixed /payment/success, /payment/failed,
 * /payment/pending and /payment/gateway pages are still reported as themselves.
 */
const PAYMENT_TOKEN_PATH = /(\/payment\/)[0-9a-f]{64}(?=[/?#]|$)/gi

export function redactInvoiceUrl(url: string): string {
  return url.replace(INVOICE_TOKEN_PATH, '$1[redacted]')
}

/** Every storefront URL that carries a capability token, redacted. */
export function redactCapabilityUrl(url: string): string {
  return redactInvoiceUrl(url).replace(PAYMENT_TOKEN_PATH, '$1[redacted]')
}
