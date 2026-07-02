'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { addressSchema, type AddressForm as AddressFormValues } from '@/lib/validation/address.schema'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RegionFields } from '@/components/address/region-fields'
import type { RegionValue } from '@/lib/address/region-value'
import type { Address } from '@/lib/types/models'

interface Props {
  initial?: Address
  pending?: boolean
  onSubmit: (values: AddressFormValues) => void
}

function regionFromAddress(a?: Address): RegionValue {
  if (!a) return {}
  return {
    provinceId: a.provinceId ?? undefined,
    provinceName: a.province?.name ?? undefined,
    cityId: a.cityId ?? undefined,
    cityName: a.city?.name ?? undefined,
    districtId: a.districtId ?? undefined,
    districtName: a.district?.name ?? undefined,
    villageId: a.villageId ?? undefined,
    villageName: a.village?.name ?? undefined,
    postalCode: a.postalCode ?? undefined,
  }
}

export function AddressForm({ initial, pending, onSubmit }: Props) {
  const [region, setRegion] = useState<RegionValue>(() => regionFromAddress(initial))

  const {
    register,
    handleSubmit,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<AddressFormValues>({
    resolver: zodResolver(addressSchema),
    defaultValues: initial
      ? {
          label: initial.label,
          recipientName: initial.recipientName,
          phone: initial.phone,
          fullAddress: initial.addressDetail ?? initial.fullAddress,
          notes: initial.notes ?? '',
          latitude: Number(initial.latitude),
          longitude: Number(initial.longitude),
          isDefault: initial.isDefault,
          provinceId: initial.provinceId ?? '',
          cityId: initial.cityId ?? '',
          districtId: initial.districtId ?? '',
          villageId: initial.villageId ?? '',
          postalCode: initial.postalCode ?? '',
        }
      : {
          label: '',
          recipientName: '',
          phone: '',
          fullAddress: '',
          notes: '',
          latitude: 0,
          longitude: 0,
          isDefault: false,
          provinceId: '',
          cityId: '',
          districtId: '',
          villageId: '',
          postalCode: '',
        },
  })

  // Keep RHF fields in sync with the chain-select cascade.
  const handleRegionChange = (next: RegionValue) => {
    setRegion(next)
    setValue('provinceId', next.provinceId ?? '', { shouldValidate: false })
    setValue('cityId', next.cityId ?? '', { shouldValidate: false })
    setValue('districtId', next.districtId ?? '', { shouldValidate: false })
    setValue('villageId', next.villageId ?? '', { shouldValidate: false })
    setValue('postalCode', next.postalCode ?? '', { shouldValidate: false })
    clearErrors(['provinceId', 'cityId', 'districtId', 'villageId', 'postalCode'])
  }

  const submit = (values: AddressFormValues) =>
    // fullAddress carries the street detail (backward compatible); addressDetail mirrors it.
    onSubmit({ ...values, addressDetail: values.fullAddress } as AddressFormValues & { addressDetail: string })

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-3">
      {/* No map picker here → coordinates default to 0; carried as hidden fields. */}
      <input type="hidden" {...register('latitude')} />
      <input type="hidden" {...register('longitude')} />
      <input type="hidden" {...register('provinceId')} />
      <input type="hidden" {...register('cityId')} />
      <input type="hidden" {...register('districtId')} />
      <input type="hidden" {...register('villageId')} />
      <input type="hidden" {...register('postalCode')} />

      <div className="space-y-1.5">
        <Label htmlFor="label">Label</Label>
        <Input id="label" placeholder="Rumah, Kantor…" {...register('label')} />
        {errors.label ? <p className="text-xs text-destructive">{errors.label.message}</p> : null}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="recipientName">Penerima</Label>
          <Input id="recipientName" {...register('recipientName')} />
          {errors.recipientName ? <p className="text-xs text-destructive">{errors.recipientName.message}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Telepon</Label>
          <Input id="phone" {...register('phone')} />
          {errors.phone ? <p className="text-xs text-destructive">{errors.phone.message}</p> : null}
        </div>
      </div>

      <RegionFields
        value={region}
        onChange={handleRegionChange}
        errors={{
          provinceId: errors.provinceId?.message,
          cityId: errors.cityId?.message,
          districtId: errors.districtId?.message,
          villageId: errors.villageId?.message,
          postalCode: errors.postalCode?.message,
        }}
      />

      <div className="space-y-1.5">
        <Label htmlFor="fullAddress">Alamat Lengkap (jalan, no. rumah, RT/RW)</Label>
        <Textarea id="fullAddress" rows={3} {...register('fullAddress')} />
        {errors.fullAddress ? <p className="text-xs text-destructive">{errors.fullAddress.message}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Catatan (opsional)</Label>
        <Textarea id="notes" rows={2} {...register('notes')} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" {...register('isDefault')} className="size-4" />
        Jadikan alamat utama
      </label>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Simpan alamat
      </Button>
    </form>
  )
}
