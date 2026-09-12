import type { Metadata } from 'next'
import type { ReactNode } from 'react'

// P2 #14: a bearer link to one customer's invoice - keep it out of search indexes,
// and never send the tokenized URL to another site as a Referer.
export const metadata: Metadata = {
  title: 'Invoice - Bakso Mas Sular',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default function InvoiceLayout({ children }: { children: ReactNode }) {
  return children
}
