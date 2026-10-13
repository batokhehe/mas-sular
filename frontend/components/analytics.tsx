'use client'

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next'
import { redactCapabilityUrl } from '@/lib/invoice/redact-url'

// P2 #14 / H4: page views report their URL; strip the invoice and payment-upload
// capability tokens from it. A client component because a function prop cannot
// cross from the server layout.
const beforeSend = (event: BeforeSendEvent): BeforeSendEvent => ({ ...event, url: redactCapabilityUrl(event.url) })

export function SiteAnalytics() {
  return <Analytics beforeSend={beforeSend} />
}
