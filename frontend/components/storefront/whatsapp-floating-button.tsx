import { buildWhatsAppUrl, WHATSAPP_ARIA_LABEL, WHATSAPP_LABEL } from '@/lib/support/whatsapp'

// Build-time public config (inlined by Next.js). Missing/invalid -> no button.
const WHATSAPP_URL = buildWhatsAppUrl(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER, process.env.NEXT_PUBLIC_WHATSAPP_MESSAGE)

if (!WHATSAPP_URL && process.env.NODE_ENV !== 'production') {
  console.warn('[WhatsAppFloatingButton] NEXT_PUBLIC_WHATSAPP_NUMBER is missing or invalid; the support button is hidden.')
}

/**
 * Floating WhatsApp support link, rendered once by StorefrontShell. No state and no
 * hooks, so it needs no "use client" of its own.
 *
 * Position: on mobile it sits ABOVE the fixed bottom nav (h-16 + safe area, md:hidden);
 * from md up, where that nav is hidden, it takes the usual 24px corner. Below `sm` it
 * is icon-only (the aria-label keeps its meaning) so it covers less of the page.
 * Motion is limited to a small scale/shadow change and respects reduced motion.
 */
export function WhatsAppFloatingButton() {
  if (!WHATSAPP_URL) return null

  return (
    <a
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={WHATSAPP_ARIA_LABEL}
      data-slot="whatsapp-floating-button"
      className="fixed right-4 bottom-[calc(4rem_+_env(safe-area-inset-bottom)_+_0.75rem)] z-40 inline-flex items-center gap-2 rounded-full bg-[#25D366] p-3 text-white shadow-lg ring-1 ring-black/5 outline-none transition-shadow hover:shadow-xl focus-visible:ring-4 focus-visible:ring-[#25D366]/40 motion-safe:transition-transform motion-safe:hover:scale-105 motion-safe:active:scale-95 sm:py-2 sm:pl-4 sm:pr-2 md:right-6 md:bottom-6 print:hidden"
    >
      <span className="hidden text-xs font-semibold leading-none sm:inline">{WHATSAPP_LABEL}</span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/15">
        <WhatsAppIcon />
      </span>
    </a>
  )
}

/** Simplified WhatsApp mark (speech bubble + handset) as inline SVG — no icon dependency. */
function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2a9.9 9.9 0 0 0-8.5 15l-1.4 5 5.1-1.3A9.9 9.9 0 1 0 12 2Zm0 1.8a8.1 8.1 0 1 1-4.1 15.1l-.3-.2-3 .8.8-2.9-.2-.3A8.1 8.1 0 0 1 12 3.8Z"
      />
      <path
        fill="currentColor"
        d="M8.7 7.3c.2 0 .4 0 .6.4l.8 1.9c.1.2.1.4 0 .6l-.4.6c-.2.2-.2.4 0 .6.4.7 1 1.4 1.6 1.9.6.5 1.2.9 1.9 1.2.2.1.4.1.6-.1l.6-.8c.2-.2.4-.2.6-.1l1.8.9c.3.1.4.3.4.5 0 .6-.3 1.3-.8 1.6-.6.4-1.4.6-2.2.4-1.4-.4-2.7-1.1-3.8-2.1-1.1-1-2-2.2-2.5-3.5-.3-.8-.2-1.7.3-2.4.3-.4.7-.7 1.1-.7h.4Z"
      />
    </svg>
  )
}
