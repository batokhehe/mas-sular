import { paymentVerificationNotice } from '@/lib/payments/verification-notice'

// Build-time public config (inlined by Next.js), the same setting as the floating
// WhatsApp button. Missing/invalid -> the sentence is shown without a number.
const NOTICE = paymentVerificationNotice(process.env.NEXT_PUBLIC_WHATSAPP_NUMBER)

/** "Pembayaranmu sedang diverifikasi…" + the admin WhatsApp number, shown after a receipt upload. */
export function PaymentVerificationNotice({ className }: { className?: string }) {
  return (
    <p data-slot="payment-verification-notice" className={className}>
      {NOTICE.text}
      {NOTICE.phone && NOTICE.whatsappUrl ? (
        <>
          {' '}
          <a
            href={NOTICE.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground underline underline-offset-2"
          >
            {NOTICE.phone}
          </a>
        </>
      ) : null}
    </p>
  )
}
