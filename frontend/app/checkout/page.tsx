'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertCircle, Loader2, MapPin, Banknote, CreditCard, Wallet, ChevronRight, Check, Plus } from 'lucide-react'
import { StorefrontShell } from '@/components/storefront/shell'
import { Empty } from '@/components/common/empty'
import { AddressForm } from '@/components/account/address-form'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
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
import { useQuery } from '@tanstack/react-query'
import { paymentsApi } from '@/lib/api/payments.api'
import { badgesFor, groupChannels, resolveChannelSelection } from '@/lib/payments/channel-view'
import { useMe } from '@/lib/query/hooks/use-me'
import { useCheckout } from '@/lib/query/hooks/use-checkout'
import { useCheckoutSummary } from '@/lib/query/hooks/use-checkout-summary'
import { useShippingOptions } from '@/lib/query/hooks/use-shipping-options'
import { useCreateAddress } from '@/lib/query/hooks/use-addresses'
import { useCartStore, selectedLines, toCheckoutItems, lineUnitPrice, lineTotal } from '@/lib/stores/cart-store'
import { useCheckoutAddressStore } from '@/lib/stores/checkout-address-store'
import { useLastOrderStore } from '@/lib/stores/last-order-store'
import { ADDRESS_BOOK_FROM_CHECKOUT, resolveCheckoutAddressId } from '@/lib/address/checkout-address'
import { ApiError } from '@/lib/api/client'
import { formatIDR } from '@/lib/utils/format'
import { formatAddressLine } from '@/lib/address/format-address'
import { checkoutSummaryRows } from '@/lib/checkout/summary'
import { groupShippingOptions, serviceLabel } from '@/lib/checkout/shipping-groups'
import { ProviderLogo } from '@/components/checkout/provider-logo'
import { cn } from '@/lib/utils'
import type { CreateOrderInput } from '@/lib/api/orders.api'
import type { Address, ShippingOption } from '@/lib/types/models'

const schema = z.object({
  address_id: z.string().min(1, 'Select a delivery address'),
  courier: z.enum(['paxel', 'jne']),
  // The selector works in CHANNEL codes from GET /payments/channels only.
  payment_channel: z.string().min(1, 'Select a payment method'),
  voucher_code: z.string().optional(),
})
type FormValues = z.infer<typeof schema>


export default function CheckoutPage() {
  // Payment options come from the API — the selector hardcodes nothing.
  const channelsQuery = useQuery({
    queryKey: ['payment-channels'],
    queryFn: () => paymentsApi.channels(),
    staleTime: 5 * 60_000,
    retry: false,
  })

  // Payment options are EXCLUSIVELY what GET /payments/channels returns — the
  // selector injects nothing of its own (Phase 4A removed the synthetic COD entry).
  const channelSections = useMemo(
    () => groupChannels(channelsQuery.data?.channels ?? []),
    [channelsQuery.data],
  )
  const router = useRouter()
  const { data: me, isLoading: meLoading } = useMe()
  const lines = useCartStore((s) => s.lines)
  const removeLines = useCartStore((s) => s.removeLines)
  const setLastOrder = useLastOrderStore((s) => s.setOrder)
  const chosenAddressId = useCheckoutAddressStore((s) => s.addressId)
  const chooseAddress = useCheckoutAddressStore((s) => s.choose)
  const clearChosenAddress = useCheckoutAddressStore((s) => s.clear)
  const createAddress = useCreateAddress()
  const [addAddressOpen, setAddAddressOpen] = useState(false)
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
    // No channel until GET /payments/channels answers (P0-3): see the effect below.
    defaultValues: { courier: 'jne', payment_channel: '', voucher_code: '' },
  })

  const addresses = me?.addresses ?? []
  // P2 #6: checkout is ONLY the lines ticked in the cart. The selection is stored on
  // the cart lines themselves, so a refresh or Back keeps the same subset; nothing
  // here ever falls back to the whole cart. Quotes, the summary and the order all
  // use this one list (ids + quantities - the server prices and validates them).
  const checkoutLines = useMemo(() => selectedLines(lines), [lines])
  const checkoutItems = useMemo(() => toCheckoutItems(lines), [lines])
  const unselectedCount = lines.length - checkoutLines.length

  // 1) Shipping availability is the courier's answer, not ours. DeliveryCoverage
  //    is deactivated for this flow: it used to gate the quote request, so a
  //    DISABLED / PICKUP_ONLY rule hid Paxel services from areas Paxel serves.
  //    An address is quotable as soon as one is selected; whether anything can
  //    actually ship there is decided by the options the provider returns.
  const selectedAddressId = watch('address_id')
  const selectedAddress = addresses.find((a) => a.id === selectedAddressId)
  const deliverable = !!selectedAddress

  // 2) Fetch shipping quotes from all providers and let the customer pick one
  //    (the provider sets the fee).
  const shippingQuery = useShippingOptions(selectedAddressId, checkoutItems, deliverable)
  const shippingOptions = shippingQuery.data ?? []
  const [selectedShipping, setSelectedShipping] = useState<ShippingOption | null>(null)
  // Presentation-only grouping; does not touch selection or the submit payload.
  const shippingGroups = useMemo(() => groupShippingOptions(shippingOptions), [shippingOptions])

  // Reset the selection when the address changes; auto-pick the cheapest option once loaded.
  useEffect(() => {
    setSelectedShipping(null)
  }, [selectedAddressId])
  useEffect(() => {
    if (!selectedShipping && shippingOptions.length > 0) {
      const cheapest = [...shippingOptions].sort((a, b) => a.shippingCost - b.shippingCost)[0]
      setSelectedShipping(cheapest)
    }
  }, [shippingOptions, selectedShipping])

  const canPlaceOrder = deliverable && !!selectedShipping

  // Voucher is debounced so the (provider-hitting) summary endpoint is not called
  // on every keystroke; the discount always comes back from the backend summary.
  const voucherCodeRaw = watch('voucher_code')
  const [debouncedVoucher, setDebouncedVoucher] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedVoucher((voucherCodeRaw ?? '').trim()), 500)
    return () => clearTimeout(t)
  }, [voucherCodeRaw])

  const selectedChannelCode = watch('payment_channel')
  // P0-3: the selection is always one of the returned channels - manual transfer
  // is preselected only when the backend offers it (an active bank account exists).
  useEffect(() => {
    if (!channelsQuery.data) return
    const next = resolveChannelSelection(getValues('payment_channel'), channelsQuery.data.channels)
    if (next !== getValues('payment_channel')) setValue('payment_channel', next)
  }, [channelsQuery.data, getValues, setValue])
  const selectedChannel = useMemo(
    () => channelSections.flatMap((s) => s.channels).find((c) => c.code === selectedChannelCode),
    [channelSections, selectedChannelCode],
  )

  // Server-authoritative money: subtotal / shipping / discount / grand total all
  // come from the backend. The frontend NEVER recalculates them.
  const summaryQuery = useCheckoutSummary({
    addressId: selectedAddressId,
    provider: selectedShipping?.provider,
    service: selectedShipping?.service,
    voucherCode: debouncedVoucher,
    paymentMethod: selectedChannel?.method,
    paymentChannel: selectedChannel?.method === 'GATEWAY' ? selectedChannel.code : undefined,
    items: checkoutItems,
    enabled: canPlaceOrder,
  })
  const summaryRows = summaryQuery.data ? checkoutSummaryRows(summaryQuery.data) : []

  // P2 #7: start from the customer's own choice (kept across an Address Book round
  // trip), else their default address, else their only one. Runs only while nothing
  // is selected, so it never overrides a choice made on this page.
  useEffect(() => {
    if (addresses.length > 0 && !getValues('address_id')) {
      const preselect = resolveCheckoutAddressId(addresses, chosenAddressId)
      if (preselect) setValue('address_id', preselect)
    }
  }, [addresses, chosenAddressId, getValues, setValue])

  // P2 #18: an address added from Checkout becomes the delivery address right away.
  const onAddressCreated = (created: Address) => {
    setValue('address_id', created.id, { shouldValidate: true })
    chooseAddress(created.id)
    setAddAddressOpen(false)
  }

  const onSubmit = (values: FormValues) => {
    setConflict(null)
    if (!selectedShipping || checkoutItems.length === 0) return
    // P0-3: never fall back to a method the customer was not offered.
    if (!selectedChannel) return
    const input: CreateOrderInput = {
      address_id: values.address_id,
      // courier kept for backward compatibility; provider+service drive the quote.
      courier: (selectedShipping.provider as 'paxel' | 'jne') ?? values.courier,
      shipping_provider: selectedShipping.provider,
      shipping_service: selectedShipping.service,
      payment_method: selectedChannel.method as CreateOrderInput['payment_method'],
      // Only meaningful for GATEWAY; the backend ignores it otherwise.
      payment_channel: selectedChannel.method === 'GATEWAY' ? selectedChannel.code : undefined,
      voucher_code: values.voucher_code || undefined,
      items: checkoutItems,
    }
    // Exactly what this request buys - captured now, so a later selection change
    // cannot alter which lines are removed. Lines (product + topping set), not product
    // ids: an unselected "Baso + Keju" must survive buying a plain "Baso".
    const purchasedLineIds = checkoutLines.map((line) => line.lineId)
    checkout.mutate(
      { input, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (order) => {
          setLastOrder(order)
          removeLines(purchasedLineIds) // unselected items stay in the cart
          clearChosenAddress() // the next checkout starts from the default address again
          // A gateway order carries its normalized instructions; send the customer
          // straight to the payment page. Everything else keeps the existing route.
          const gateway = order as unknown as { paymentInstruction?: unknown; payment?: { id?: string } }
          if (gateway.paymentInstruction && gateway.payment?.id) {
            router.push(`/payment/gateway/${gateway.payment.id}`)
            return
          }
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

  // Items in the cart but none ticked: nothing to buy. Never fall back to the cart.
  if (checkoutLines.length === 0) {
    return (
      <StorefrontShell>
        <Empty
          title="No items selected"
          description="Select the items you want to buy in your cart, then check out."
          action={
            <Button asChild className="mt-2">
              <Link href="/cart">Back to cart</Link>
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
                    <Button type="button" size="sm" onClick={() => setAddAddressOpen(true)}>
                      <Plus className="mr-1 size-4" /> Add address
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
                          <Select
                            value={field.value}
                            onValueChange={(id) => {
                              // Radix's hidden native <select> reports '' while its options
                              // are still mounting. That is not a customer choice, and it
                              // used to wipe the preselected default address (P2 #7).
                              if (!id) return
                              field.onChange(id)
                              chooseAddress(id)
                            }}
                          >
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
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant="outline" size="sm" onClick={() => setAddAddressOpen(true)}>
                              <Plus className="mr-1 size-4" /> Add address
                            </Button>
                            <Button asChild variant="outline" size="sm">
                              <Link href={ADDRESS_BOOK_FROM_CHECKOUT}>Change address</Link>
                            </Button>
                          </div>
                        </div>
                      )
                    }}
                  />
                )}
                {errors.address_id ? <p className="text-sm text-destructive">{errors.address_id.message}</p> : null}

              </Card>

              {/* Order items (the cart lines selected for this checkout) */}
              <Card className="space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 className="font-semibold">Order ({checkoutLines.length} items)</h2>
                  {unselectedCount > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {unselectedCount} unselected {unselectedCount === 1 ? 'item stays' : 'items stay'} in your cart ·{' '}
                      <Link href="/cart" className="font-medium text-primary hover:underline">
                        Change selection
                      </Link>
                    </p>
                  ) : null}
                </div>
                <ul className="space-y-3">
                  {checkoutLines.map((line) => (
                    <li key={line.lineId} className="flex items-center gap-3">
                      <div className="relative size-14 shrink-0 overflow-hidden rounded-lg bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={line.imageUrl} alt={line.name} className="size-full object-cover" />
                        <span className="absolute bottom-0 right-0 rounded-tl bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                          x{line.qty}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium">{line.name}</p>
                        {line.toppings.length > 0 && (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            + {line.toppings.map((t) => `${t.name} (${formatIDR(t.price)})`).join(', ')}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">{formatIDR(lineUnitPrice(line))} each</p>
                      </div>
                      {/* Unit price (product + toppings) × qty (same per-line summation as cartSubtotal). */}
                      <p className="text-sm font-semibold text-primary">{formatIDR(lineTotal(line))}</p>
                    </li>
                  ))}
                </ul>
              </Card>

              {/* Shipping service + payment */}
              <Card className="space-y-4 p-4">
                <div className="space-y-2">
                  <Label>Shipping method</Label>
                  {!selectedAddress ? (
                    <p className="text-sm text-muted-foreground">Select a delivery address first.</p>
                  ) : shippingQuery.isFetching ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" /> Loading shipping options…
                    </p>
                  ) : shippingQuery.isError ? (
                    <p className="text-sm text-destructive">Unable to load shipping options for this address.</p>
                  ) : shippingOptions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No shipping services available.</p>
                  ) : (
                    // Grouped by the backend's stable `provider` id — presentation
                    // only; each button still selects the exact option object.
                    <div className="space-y-4">
                      {shippingGroups.map((group) => (
                        <div key={group.provider} className="space-y-2">
                          <div className="flex items-center gap-2">
                            <ProviderLogo provider={group.provider} title={group.title} />
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {group.title}
                            </h3>
                          </div>
                          {group.options.map((opt) => {
                            const active =
                              selectedShipping?.provider === opt.provider &&
                              selectedShipping?.service === opt.service
                            return (
                              <button
                                type="button"
                                key={`${opt.provider}-${opt.service}`}
                                onClick={() => setSelectedShipping(opt)}
                                aria-pressed={active}
                                className={cn(
                                  'flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors',
                                  active ? 'border-primary bg-primary/5' : 'hover:border-primary/50',
                                )}
                              >
                                <div className="min-w-0">
                                  <p className="text-sm font-medium">{serviceLabel(opt)}</p>
                                  <p className="text-xs text-muted-foreground">{opt.estimatedDays}</p>
                                </div>
                                {/* Always rendered, only faded — keeps the price
                                    aligned and gives the selected state a
                                    non-colour cue. */}
                                <span className="flex shrink-0 items-center gap-2">
                                  <Check
                                    aria-hidden="true"
                                    className={cn('size-4 text-primary', active ? 'opacity-100' : 'opacity-0')}
                                  />
                                  <span className="text-sm font-semibold">{formatIDR(opt.shippingCost)}</span>
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <Label>Metode pembayaran</Label>
                  {channelsQuery.isLoading ? (
                    <div className="space-y-2">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="h-14 animate-pulse rounded-xl bg-muted" />
                      ))}
                    </div>
                  ) : channelSections.length === 0 ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      Belum ada metode pembayaran yang tersedia. Silakan coba lagi nanti.
                    </p>
                  ) : (
                    <Controller
                      control={control}
                      name="payment_channel"
                      render={({ field }) => (
                        <RadioGroup value={field.value} onValueChange={field.onChange} className="space-y-4">
                          {channelSections.map((section) => (
                            <div key={section.title} className="space-y-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {section.title}
                              </p>
                              {section.channels.map((channel) => {
                                const active = field.value === channel.code
                                return (
                                  <Label
                                    key={channel.code}
                                    htmlFor={`pm-${channel.code}`}
                                    className={cn(
                                      'flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors',
                                      active ? 'border-primary bg-primary/5' : 'hover:border-primary/50',
                                    )}
                                  >
                                    <RadioGroupItem value={channel.code} id={`pm-${channel.code}`} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-sm font-medium">{channel.label}</p>
                                        {badgesFor(channel).map((badge) => (
                                          <span
                                            key={badge}
                                            className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                                          >
                                            {badge}
                                          </span>
                                        ))}
                                      </div>
                                      {channel.description && (
                                        <p className="text-xs text-muted-foreground">{channel.description}</p>
                                      )}
                                    </div>
                                  </Label>
                                )
                              })}
                            </div>
                          ))}
                        </RadioGroup>
                      )}
                    />
                  )}
                  {errors.payment_channel && (
                    <p className="text-xs text-destructive">{errors.payment_channel.message}</p>
                  )}
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
                {/* Every amount below is rendered verbatim from the backend
                    /checkout/summary response — the client performs no money math. */}
                {!canPlaceOrder ? (
                  <p className="text-xs text-muted-foreground">
                    Select a delivery address and shipping service to see the total.
                  </p>
                ) : summaryQuery.isLoading ? (
                  <div className="space-y-2" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-4 w-full animate-pulse rounded bg-muted" />
                    ))}
                  </div>
                ) : summaryQuery.isError ? (
                  <p className="text-xs text-destructive">
                    {(summaryQuery.error as Error)?.message ?? 'Unable to load the order total.'}
                  </p>
                ) : (
                  summaryRows.map((row) => (
                    <div
                      key={row.key}
                      className={cn(
                        'flex items-center justify-between text-sm',
                        row.key === 'grand_total' && 'font-semibold',
                      )}
                    >
                      <span className={row.key === 'grand_total' ? '' : 'text-muted-foreground'}>{row.label}</span>
                      <span className={row.key === 'grand_total' ? '' : 'font-medium'}>
                        {row.key === 'discount' ? `- ${formatIDR(Math.abs(row.value))}` : formatIDR(row.value)}
                      </span>
                    </div>
                  ))
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

        {/*
          Rendered OUTSIDE the checkout <form>: AddressForm is a form of its own, and a
          portal still bubbles React's submit event to its React parents - inside, saving
          an address would also submit the order.
        */}
        <Dialog open={addAddressOpen} onOpenChange={setAddAddressOpen}>
          {/* Scrolls on short phones - the form is taller than a 667px screen. */}
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New address</DialogTitle>
            </DialogHeader>
            <AddressForm
              pending={createAddress.isPending}
              onSubmit={(values) =>
                createAddress.mutate({ ...values, isDefault: values.isDefault ?? false }, { onSuccess: onAddressCreated })
              }
            />
          </DialogContent>
        </Dialog>
      </section>
    </StorefrontShell>
  )
}
