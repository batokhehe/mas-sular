/**
 * Pure view helpers for the payment selector. No React, no fetch — unit-testable
 * standalone. The channel list itself ALWAYS comes from GET /payments/channels;
 * nothing here hardcodes a payment option.
 */

export type PaymentChannelGroup = 'MANUAL' | 'QR' | 'EWALLET' | 'VIRTUAL_ACCOUNT' | 'CARD'

export interface PublicPaymentChannel {
  code: string
  label: string
  group: PaymentChannelGroup
  /** Selectable business methods only — COD is not offered (Phase 4A). */
  method: 'BANK_TRANSFER' | 'GATEWAY' | 'QRIS'
  logoUrl: string | null
  icon: string
  sortOrder: number
  description?: string
  recommended?: boolean
  popular?: boolean
  instant?: boolean
}

export interface ChannelGroupView {
  group: PaymentChannelGroup
  /** Section heading exactly as specified, emoji included. */
  title: string
  channels: PublicPaymentChannel[]
}

/** Section order + headings. QR joins the e-wallet section (QRIS is scan-to-pay). */
const GROUP_TITLES: Record<PaymentChannelGroup, string> = {
  MANUAL: '🏦 Transfer Bank',
  QR: '⚡ E-Wallet',
  EWALLET: '⚡ E-Wallet',
  VIRTUAL_ACCOUNT: '🏦 Virtual Account',
  CARD: '💳 Credit Card',
}

const SECTION_ORDER: PaymentChannelGroup[] = ['MANUAL', 'QR', 'EWALLET', 'VIRTUAL_ACCOUNT', 'CARD']

/**
 * Group channels into the four checkout sections, each sorted by `sortOrder`.
 * QR and EWALLET share one heading, so they are merged into a single section.
 * Empty sections are dropped — a channel the backend did not return is simply
 * not offered.
 */
export function groupChannels(channels: PublicPaymentChannel[]): ChannelGroupView[] {
  const sections: ChannelGroupView[] = []

  for (const group of SECTION_ORDER) {
    const items = channels.filter((c) => c.group === group).sort((a, b) => a.sortOrder - b.sortOrder)
    if (items.length === 0) continue

    const title = GROUP_TITLES[group]
    const existing = sections.find((s) => s.title === title)
    if (existing) {
      existing.channels = [...existing.channels, ...items].sort((a, b) => a.sortOrder - b.sortOrder)
      continue
    }
    sections.push({ group, title, channels: items })
  }

  return sections
}

/** Badge labels driven entirely by backend metadata. */
export function badgesFor(channel: PublicPaymentChannel): string[] {
  const badges: string[] = []
  if (channel.recommended) badges.push('Disarankan')
  if (channel.popular) badges.push('Populer')
  if (channel.instant) badges.push('Instan')
  return badges
}

/** The payment_method a channel selection must submit with. */
export function methodForChannel(channel: PublicPaymentChannel): string {
  return channel.method
}
