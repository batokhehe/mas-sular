'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { addressSchema, type AddressForm as AddressFormValues } from '@/lib/validation/address.schema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Address } from '@/lib/types/models'

interface Props {
  initial?: Address
  pending?: boolean
  onSubmit: (values: AddressFormValues) => void
}

export function AddressForm({ initial, pending, onSubmit }: Props) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<AddressFormValues>({
    resolver: zodResolver(addressSchema),
    defaultValues: initial
      ? {
          label: initial.label,
          recipientName: initial.recipientName,
          phone: initial.phone,
          fullAddress: initial.fullAddress,
          notes: initial.notes ?? '',
          latitude: Number(initial.latitude),
          longitude: Number(initial.longitude),
          isDefault: initial.isDefault,
        }
      : { label: '', recipientName: '', phone: '', fullAddress: '', notes: '', latitude: 0, longitude: 0, isDefault: false },
  })

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      {/* No map picker yet → coordinates default to 0; carried as hidden fields. */}
      <input type="hidden" {...register('latitude')} />
      <input type="hidden" {...register('longitude')} />

      <div className="space-y-1.5">
        <Label htmlFor="label">Label</Label>
        <Input id="label" placeholder="Home, Office…" {...register('label')} />
        {errors.label ? <p className="text-xs text-destructive">{errors.label.message}</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="recipientName">Recipient</Label>
          <Input id="recipientName" {...register('recipientName')} />
          {errors.recipientName ? <p className="text-xs text-destructive">{errors.recipientName.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" {...register('phone')} />
          {errors.phone ? <p className="text-xs text-destructive">{errors.phone.message}</p> : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="fullAddress">Full address</Label>
        <Textarea id="fullAddress" rows={3} {...register('fullAddress')} />
        {errors.fullAddress ? <p className="text-xs text-destructive">{errors.fullAddress.message}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea id="notes" rows={2} {...register('notes')} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...register('isDefault')} className="size-4" />
        Set as default address
      </label>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Save address
      </Button>
    </form>
  )
}
