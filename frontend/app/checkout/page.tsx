'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertCircle, Loader2 } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { Empty } from '@/components/common/empty'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMe } from '@/lib/query/hooks/use-me'
import { useCheckout } from '@/lib/query/hooks/use-checkout'
import { useCartStore, cartSubtotal } from '@/lib/stores/cart-store'
import { useLastOrderStore } from '@/lib/stores/last-order-store'
import { ApiError } from '@/lib/api/client'
import { formatIDR } from '@/lib/utils/format'
import type { CreateOrderInput } from '@/lib/api/orders.api'

const schema = z.object({
  address_id: z.string().min(1, 'Select a delivery address'),
  courier: z.enum(['paxel', 'jne']),
  payment_method: z.enum(['COD', 'BANK_TRANSFER', 'QRIS']),
  voucher_code: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

export default function CheckoutPage() {
  const router = useRouter()
  const { data: me, isLoading: meLoading } = useMe()
  const lines = useCartStore((s) => s.lines)
  const clearCart = useCartStore((s) => s.clear)
  const setLastOrder = useLastOrderStore((s) => s.setOrder)
  const checkout = useCheckout()

  // Idempotency key — stable across retries; regenerated only on a 422 mismatch.
  const idempotencyKey = useRef<string>(crypto.randomUUID())
  const [conflict, setConflict] = useState<null | 'processing' | 'mismatch'>(null)

  const {
    control,
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { courier: 'jne', payment_method: 'BANK_TRANSFER', voucher_code: '' },
  })

  const addresses = me?.addresses ?? []
  const subtotal = cartSubtotal(lines)

  // Preselect the default (or only) address once it loads; don't override a later
  // manual choice.
  useEffect(() => {
    if (addresses.length > 0 && !getValues('address_id')) {
      const preselect = addresses.find((a) => a.isDefault) ?? addresses[0]
      setValue('address_id', preselect.id)
    }
  }, [addresses, getValues, setValue])

  const onSubmit = (values: FormValues) => {
    setConflict(null)
    const input: CreateOrderInput = {
      address_id: values.address_id,
      courier: values.courier,
      payment_method: values.payment_method,
      voucher_code: values.voucher_code || undefined,
      items: lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
    }
    checkout.mutate(
      { input, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (order) => {
          setLastOrder(order)
          clearCart()
          router.push('/checkout/success')
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) setConflict('processing')
          else if (err instanceof ApiError && err.status === 422) {
            setConflict('mismatch')
            idempotencyKey.current = crypto.randomUUID() // new attempt for a changed cart
          }
        },
      },
    )
  }

  if (meLoading) {
    return (
      <StorefrontShell>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted-foreground">Loading…</div>
      </StorefrontShell>
    )
  }

  if (!me) {
    return (
      <StorefrontShell>
        <Empty
          title="Please sign in to checkout"
          description="You need an account to place an order."
          action={
            <Button asChild className="mt-2">
              <Link href="/login">Sign in</Link>
            </Button>
          }
        />
      </StorefrontShell>
    )
  }

  if (lines.length === 0) {
    return (
      <StorefrontShell>
        <Empty
          title="Your cart is empty"
          action={
            <Button asChild className="mt-2">
              <Link href="/catalog">Browse catalog</Link>
            </Button>
          }
        />
      </StorefrontShell>
    )
  }

  return (
    <StorefrontShell>
      <section className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Checkout</h1>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Address */}
          <Card className="space-y-2 p-4">
            <Label>Delivery address</Label>
            {addresses.length === 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">You need a delivery address to check out.</p>
                <Button asChild variant="outline" size="sm">
                  <Link href="/account/addresses">Add address first</Link>
                </Button>
              </div>
            ) : (
              <Controller
                control={control}
                name="address_id"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an address" />
                    </SelectTrigger>
                    <SelectContent>
                      {addresses.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.label} — {a.recipientName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
            {errors.address_id ? <p className="text-sm text-destructive">{errors.address_id.message}</p> : null}
          </Card>

          {/* Courier + payment */}
          <Card className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Shipping method</Label>
              <Controller
                control={control}
                name="courier"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jne">JNE (Regular)</SelectItem>
                      <SelectItem value="paxel">Paxel (Same day)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label>Payment method</Label>
              <Controller
                control={control}
                name="payment_method"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BANK_TRANSFER">Bank transfer</SelectItem>
                      <SelectItem value="QRIS">QRIS</SelectItem>
                      <SelectItem value="COD">Cash on delivery</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </Card>

          {/* Voucher */}
          <Card className="space-y-2 p-4">
            <Label htmlFor="voucher">Voucher code (optional)</Label>
            <Input id="voucher" placeholder="e.g. WELCOME10" {...register('voucher_code')} />
          </Card>

          {/* Summary */}
          <Card className="space-y-2 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal ({lines.length} items)</span>
              <span>{formatIDR(subtotal)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Shipping and discounts are calculated by the server on order creation.
            </p>
            <Separator />
          </Card>

          {conflict ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 text-amber-600" />
              <span>
                {conflict === 'processing'
                  ? 'Your order is already being processed. Wait a moment, then retry — it will not create a duplicate.'
                  : 'Your cart changed since the last attempt. Review and place the order again.'}
              </span>
            </div>
          ) : null}

          <Button type="submit" size="lg" className="w-full" disabled={checkout.isPending}>
            {checkout.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" /> Placing order…
              </>
            ) : (
              'Place order'
            )}
          </Button>
        </form>
      </section>
    </StorefrontShell>
  )
}
