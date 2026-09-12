'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { ArrowLeft, Check, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { AddressForm } from '@/components/account/address-form'
import { Empty } from '@/components/common/empty'
import { ErrorState } from '@/components/common/error-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  useAddresses,
  useCreateAddress,
  useUpdateAddress,
  useDeleteAddress,
} from '@/lib/query/hooks/use-addresses'
import type { Address } from '@/lib/types/models'
import { formatAddressLine } from '@/lib/address/format-address'
import { RETURN_PARAM, resolveCheckoutAddressId, safeAddressBookReturn } from '@/lib/address/checkout-address'
import { useCheckoutAddressStore } from '@/lib/stores/checkout-address-store'

export default function AddressBookPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <AddressBook />
    </Suspense>
  )
}

function AddressBook() {
  const { data, isLoading, isError, refetch } = useAddresses()
  const create = useCreateAddress()
  const update = useUpdateAddress()
  const remove = useDeleteAddress()

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Address | null>(null)
  const [deleting, setDeleting] = useState<Address | null>(null)

  const addresses = data ?? []

  // P2 #17/#18: opened from Checkout (?returnTo=/checkout) the page offers "Back to
  // checkout" and lets the customer pick the delivery address. Anything else in the
  // parameter - or none - is a normal, direct visit.
  const returnTo = safeAddressBookReturn(useSearchParams().get(RETURN_PARAM))
  const chosenAddressId = useCheckoutAddressStore((s) => s.addressId)
  const chooseAddress = useCheckoutAddressStore((s) => s.choose)
  const deliveryAddressId = returnTo ? resolveCheckoutAddressId(addresses, chosenAddressId) : null

  return (
    <section className="mx-auto max-w-2xl px-4 py-8">
      {returnTo ? (
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
          <Link href={returnTo}>
            <ArrowLeft className="mr-1 size-4" /> Back to checkout
          </Link>
        </Button>
      ) : null}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Address Book</h1>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 size-4" /> Add address
            </Button>
          </DialogTrigger>
          {/* Scrolls on short phones - the form is taller than a 667px screen. */}
          <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>New address</DialogTitle>
            </DialogHeader>
            <AddressForm
              pending={create.isPending}
              onSubmit={(values) =>
                create.mutate(
                  { ...values, isDefault: values.isDefault ?? false },
                  {
                    onSuccess: (created) => {
                      // From Checkout, a new address is the one the customer wants delivered to.
                      if (returnTo) chooseAddress(created.id)
                      setCreateOpen(false)
                    },
                  },
                )
              }
            />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : addresses.length === 0 ? (
        <Empty
          title="No addresses yet"
          description="Add a delivery address to start ordering."
          action={
            <Button className="mt-2" onClick={() => setCreateOpen(true)}>
              Add address
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {addresses.map((address) => (
            <Card key={address.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{address.label}</p>
                    {address.isDefault ? <Badge>Default</Badge> : null}
                  </div>
                  <p className="text-sm">
                    {address.recipientName} · {address.phone}
                  </p>
                  <p className="text-sm text-muted-foreground">{formatAddressLine(address)}</p>
                  {address.notes ? <p className="text-xs text-muted-foreground">Notes: {address.notes}</p> : null}
                  {returnTo ? (
                    address.id === deliveryAddressId ? (
                      <p className="flex items-center gap-1 pt-1 text-sm font-medium text-primary">
                        <Check className="size-4" /> Selected for delivery
                      </p>
                    ) : (
                      <Button variant="outline" size="sm" className="mt-1" onClick={() => chooseAddress(address.id)}>
                        Deliver here
                      </Button>
                    )
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!address.isDefault ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      title="Set as default"
                      onClick={() => update.mutate({ id: address.id, body: { isDefault: true } })}
                    >
                      <Star className="size-4" />
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="icon" className="size-8" title="Edit" onClick={() => setEditing(address)}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-destructive"
                    title="Delete"
                    onClick={() => setDeleting(address)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit address</DialogTitle>
          </DialogHeader>
          {editing ? (
            <AddressForm
              initial={editing}
              pending={update.isPending}
              onSubmit={(values) =>
                update.mutate({ id: editing.id, body: values }, { onSuccess: () => setEditing(null) })
              }
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete address?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleting ? `“${deleting.label}” will be removed.` : ''}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                deleting && remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
