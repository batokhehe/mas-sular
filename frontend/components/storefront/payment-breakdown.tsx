'use client'

import { formatIDR } from '@/lib/utils/format'
import { paymentBreakdownRows, type PaymentBreakdownInput } from '@/lib/checkout/summary'

const EXPLANATION =
  'Kode unik pembayaran digunakan untuk mempermudah proses verifikasi pembayaran. Mohon transfer sesuai nominal yang tertera.'

/**
 * Presentational payment breakdown shared by the checkout-success and payment-upload
 * pages. It renders ONLY the backend values it is given (via `paymentBreakdownRows`)
 * and performs no arithmetic:
 *   Subtotal / Shipping / Voucher Discount   (success page only)
 *   ───────────────
 *   Business Total          = Order.totalPrice
 *   Unique Payment Code     = Payment.uniqueCode   (emphasized, only if present)
 *   ═══════════════
 *   Transfer Exactly        = Payment.amount        (highlighted)
 */
export function PaymentBreakdown(props: PaymentBreakdownInput) {
  const rows = paymentBreakdownRows(props)
  const lineRows = rows.filter((r) => r.kind === 'line' || r.kind === 'discount')
  const business = rows.find((r) => r.kind === 'business')
  const code = rows.find((r) => r.kind === 'code')
  const transfer = rows.find((r) => r.kind === 'transfer')

  return (
    <div className="space-y-3" data-testid="payment-breakdown">
      {lineRows.length > 0 ? (
        <div className="space-y-1.5">
          {lineRows.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-medium">
                {r.kind === 'discount' ? `- ${formatIDR(r.value)}` : formatIDR(r.value)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {lineRows.length > 0 ? <div className="border-t border-border" /> : null}

      {business ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{business.label}</span>
          <span className="font-semibold" data-testid="business-total">
            {formatIDR(business.value)}
          </span>
        </div>
      ) : null}

      {code ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{code.label}</span>
          <span className="font-bold text-emerald-600" data-testid="unique-code">
            +{code.value}
          </span>
        </div>
      ) : null}

      {transfer ? (
        <div className="border-t-2 border-dashed border-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{transfer.label}</span>
            <span className="text-lg font-bold text-emerald-700" data-testid="transfer-exactly">
              {formatIDR(transfer.value)}
            </span>
          </div>
        </div>
      ) : null}

      {code ? <p className="text-xs text-muted-foreground">{EXPLANATION}</p> : null}
    </div>
  )
}
