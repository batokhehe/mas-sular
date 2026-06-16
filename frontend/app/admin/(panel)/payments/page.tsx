'use client'

import { useState } from 'react'
import { Check, Eye, Loader2, X } from 'lucide-react'
import { useAdminPayments } from '@/lib/query/hooks/use-admin-payments'
import { useVerifyPayment } from '@/lib/query/hooks/use-verify-payment'
import { useRejectPayment } from '@/lib/query/hooks/use-reject-payment'
import { usePermissions } from '@/lib/auth/use-permissions'
import { formatIDR } from '@/lib/utils/format'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { Empty } from '@/components/common/empty'
import { ErrorState } from '@/components/common/error-state'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Payment } from '@/lib/types/models'
import type { PaymentStatus } from '@/lib/types/enums'

const STATUS_OPTIONS: PaymentStatus[] = ['WAITING_VERIFICATION', 'PENDING', 'EXPIRED', 'PAID', 'FAILED']
const UPLOADABLE = new Set<PaymentStatus>(['PENDING', 'WAITING_VERIFICATION'])

function statusVariant(status: PaymentStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'PAID') return 'default'
  if (status === 'EXPIRED' || status === 'FAILED') return 'destructive'
  return 'secondary'
}

function ReceiptDialog({ url, orderNumber }: { url: string; orderNumber: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Eye className="mr-1 size-4" /> Receipt
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receipt · {orderNumber}</DialogTitle>
        </DialogHeader>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Payment receipt" className="max-h-[70vh] w-full rounded-md object-contain" />
      </DialogContent>
    </Dialog>
  )
}

function RejectDialog({
  paymentId,
  onReject,
  pending,
}: {
  paymentId: string
  onReject: (id: string, note?: string) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" disabled={pending}>
          <X className="mr-1 size-4" /> Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject payment</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This cancels the order and restores stock. Add an optional reason.
        </p>
        <Textarea placeholder="Reason (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onReject(paymentId, note || undefined)
              setOpen(false)
            }}
          >
            {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Confirm reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function AdminPaymentsPage() {
  const { can } = usePermissions()
  const [status, setStatus] = useState<PaymentStatus>('WAITING_VERIFICATION')
  const { data, isLoading, isError, refetch } = useAdminPayments(status)
  const verify = useVerifyPayment()
  const reject = useRejectPayment()

  if (!can('Payment.read')) {
    return <Empty title="No access" description="You do not have permission to view payments." />
  }

  const payments: Payment[] = data ?? []
  const isVerifying = (id: string) => verify.isPending && verify.variables?.id === id
  const isRejecting = (id: string) => reject.isPending && reject.variables?.id === id

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Payment Verification</h1>
        <Select value={status} onValueChange={(v) => setStatus(v as PaymentStatus)}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : payments.length === 0 ? (
        <Empty title={`No ${status} payments`} description="Nothing to show for this filter." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.order?.orderNumber ?? '—'}</TableCell>
                  <TableCell>{p.order?.user?.name ?? '—'}</TableCell>
                  <TableCell>{formatIDR(p.amount)}</TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
                      {p.firstReminderAt || p.secondReminderAt ? (
                        <Badge variant="outline">REMINDER_SENT</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {p.manualReceiptUrl ? (
                        <ReceiptDialog url={p.manualReceiptUrl} orderNumber={p.order?.orderNumber ?? p.id} />
                      ) : null}
                      {UPLOADABLE.has(p.status) && can('Payment.verify') ? (
                        <Button
                          size="sm"
                          disabled={isVerifying(p.id)}
                          onClick={() => verify.mutate({ id: p.id })}
                        >
                          {isVerifying(p.id) ? (
                            <Loader2 className="mr-1 size-4 animate-spin" />
                          ) : (
                            <Check className="mr-1 size-4" />
                          )}
                          Verify
                        </Button>
                      ) : null}
                      {UPLOADABLE.has(p.status) && can('Payment.reject') ? (
                        <RejectDialog
                          paymentId={p.id}
                          pending={isRejecting(p.id)}
                          onReject={(id, note) => reject.mutate({ id, note })}
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
