'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertCircle, Loader2, MapPin, Banknote, CreditCard, Wallet, ChevronRight } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { Empty } from '@/components/common/empty'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMe } from '@/lib/query/hooks/use-me'
import { useCheckout } from '@/lib/query/hooks/use-checkout'
import { useCoverageCheck } from '@/lib/query/hooks/use-delivery-coverage'
import { useCartStore, cartSubtotal } from '@/lib/stores/cart-store'
import { useLastOrderStore } from '@/lib/stores/last-order-store'
import { ApiError } from '@/lib/api/client'
import { formatIDR } from '@/lib/utils/format'
import { formatAddressLine } from '@/lib/address/format-address'
import { cn } from '@/lib/utils'
import type { CreateOrderInput } from '@/lib/api/orders.api'

const schema = z.object({
  address_id: z.string().min(1, 'Select a delivery address'),
  courier: z.enum(['paxel', 'jne']),
  payment_method: z.enum(['COD', 'BANK_TRANSFER', 'QRIS']),
  voucher_code: z.string().optional(),
})
type FormValues = z.infer<typeof schema>

// Visual config only — values are the exact payment_method enum the schema/payload use.
const PAYMENT_METHODS = [
  { value: 'BANK_TRANSFER', name: 'Bank transfer', description: 'Manual transfer', icon: Banknote },
  { value: 'QRIS', name: 'QRIS', description: 'Scan to pay', icon: CreditCard },
  { value: 'COD', name: 'Cash on delivery', description: 'Pay when it arrives', icon: Wallet },
] as const

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
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { courier: 'jne', payment_method: 'BANK_TRANSFER', voucher_code: '' },
  })

  const addresses = me?.addresses ?? []
  const subtotal = cartSubtotal(lines)

  // Delivery coverage for the selected address (drives fee, estimate, and gating).
  const selectedAddressId = watch('address_id')
  const selectedAddress = addresses.find((a) => a.id === selectedAddressId)
  const coverageQuery = useCoverageCheck(selectedAddress)
  const coverage = coverageQuery.data
  const coverageBlocked = coverage?.coverageType === 'DISABLED'
  const coveragePickupOnly = coverage?.coverageType === 'PICKUP_ONLY'
  const deliveryFee = coverage?.deliverable ? coverage.deliveryFee : 0
  const belowMinimum = !!coverage?.deliverable && subtotal < coverage.minimumOrder
  const canPlaceOrder = !coverageBlocked && !coveragePickupOnly && !belowMinimum

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
      <section className="mx-auto max-w-5xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold">Checkout</h1>

        <form onSubmit={handleSubmit(onSubmit)}>
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            {/* Left column */}
            <div className="space-y-4">
              {/* Address */}
              <Card className="space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <MapPin className="size-4 text-primary" />
                  <Label className="text-base font-semibold">Delivery address</Label>
                </div>
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
                    render={({ field }) => {
                      const selected = addresses.find((a) => a.id === field.value)
                      return (
                        <div className="space-y-2">
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
                          {selected ? (
                            <div className="rounded-md bg-muted/50 p-3 text-sm">
                              <p className="font-medium">
                                {selected.recipientName} · {selected.phone}
                              </p>
                              <p className="mt-0.5 text-muted-foreground">{formatAddressLine(selected)}</p>
                            </div>
                          ) : null}
                        </div>
                      )
                    }}
                  />
                )}
                {errors.address_id ? <p className="text-sm text-destructive">{errors.address_id.message}</p> : null}

                {/* Delivery coverage status for the selected address */}
                {selectedAddress && coverageQuery.isFetching ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> Checking delivery coverage…
                  </p>
                ) : null}
                {coverageBlocked ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4" />
                    <span>Sorry, we do not currently deliver to your location.</span>
                  </div>
                ) : coveragePickupOnly ? (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 size-4" />
                    <span>This area is only available for Pickup.</span>
                  </div>
                ) : coverage?.deliverable ? (
                  <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
                    <p className="font-medium">Delivery available to this area.</p>
                    <p className="mt-0.5 text-emerald-700">
                      Delivery fee {formatIDR(coverage.deliveryFee)}
                      {coverage.estimatedMinutes ? ` · est. ${coverage.estimatedMinutes} min` : ''}
                    </p>
                    {belowMinimum ? (
                      <p className="mt-1 font-medium text-destructive">
                        Minimum order for this area is {formatIDR(coverage.minimumOrder)}.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Card>

              {/* Order items (real cart lines) */}
              <Card className="space-y-3 p-4">
                <h2 className="font-semibold">Order ({lines.length} items)</h2>
                <ul className="space-y-3">
                  {lines.map((line) => (
                    <li key={line.productId} className="flex items-center gap-3">
                      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={line.imageUrl} alt={line.name} className="size-full object-cover" />
                        <span className="absolute bottom-0 right-0 rounded-tl bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                          x{line.qty}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium">{line.name}</p>
                        <p className="text-xs text-muted-foreground">{formatIDR(line.price)} each</p>
                      </div>
                      {/* Real unit price × real qty (same per-line summation as cartSubtotal). */}
                      <p className="text-sm font-semibold text-primary">{formatIDR(line.price * line.qty)}</p>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* Courier + payment */}
              <Card className="space-y-4 p-4">
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
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="space-y-2">
                        {PAYMENT_METHODS.map((m) => {
                          const Icon = m.icon
                          const active = field.value === m.value
                          return (
                            <Label
                              key={m.value}
                              htmlFor={`pm-${m.value}`}
                              className={cn(
                                'flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors',
                                active ? 'border-primary bg-primary/5' : 'hover:border-primary/50',
                              )}
                            >
                              <RadioGroupItem value={m.value} id={`pm-${m.value}`} />
                              <Icon className="size-5 text-muted-foreground" />
                              <div className="flex-1">
                                <p className="text-sm font-medium">{m.name}</p>
                                <p className="text-xs text-muted-foreground">{m.description}</p>
                              </div>
                            </Label>
                          )
                        })}
                      </RadioGroup>
                    )}
                  />
                </div>
              </Card>
            </div>

            {/* Right column — sticky summary */}
            <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
              <Card className="space-y-2 p-4">
                <Label htmlFor="voucher">Voucher code (optional)</Label>
                <Input id="voucher" placeholder="e.g. WELCOME10" {...register('voucher_code')} />
              </Card>

              <Card className="space-y-3 p-4">
                <h2 className="font-semibold">Order summary</h2>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal ({lines.length} items)</span>
                  <span className="font-medium">{formatIDR(subtotal)}</span>
                </div>
                {coverage?.deliverable ? (
                  <>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Delivery fee</span>
                      <span className="font-medium">{formatIDR(deliveryFee)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm font-semibold">
                      <span>Grand total</span>
                      <span>{formatIDR(subtotal + deliveryFee)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Voucher discounts (if any) are applied by the server on order creation.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Shipping and discounts are calculated by the server on order creation.
                  </p>
                )}
                <Separator />

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

                <Button
                  type="submit"
                  size="lg"
                  className="w-full rounded-full"
                  disabled={checkout.isPending || !canPlaceOrder}
                >
                  {checkout.isPending ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" /> Placing order…
                    </>
                  ) : coverageBlocked ? (
                    'Delivery unavailable in this area'
                  ) : coveragePickupOnly ? (
                    'Pickup only in this area'
                  ) : (
                    <>
                      Place order
                      <ChevronRight className="ml-1 size-4" />
                    </>
                  )}
                </Button>
              </Card>
            </div>
          </div>
        </form>
      </section>
    </StorefrontShell>
  )
}
