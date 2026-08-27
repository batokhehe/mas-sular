'use client'

import { Suspense, useCallback, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/lib/auth/auth-context'
import { useCreateAddress } from '@/lib/query/hooks/use-addresses'
import { qk } from '@/lib/query/keys'
import type { User } from '@/lib/types/models'
import { RegionFields } from '@/components/address/region-fields'
import type { RegionValue } from '@/lib/address/region-value'

const addressSchema = z.object({
  recipientName: z.string().min(2, 'Nama penerima minimal 2 karakter'),
  phone: z.string().min(10, 'Nomor telepon tidak valid').max(15),
  fullAddress: z.string().min(10, 'Alamat lengkap minimal 10 karakter'),
  notes: z.string().optional(),
  provinceId: z.string().min(1, 'Provinsi wajib dipilih'),
  cityId: z.string().min(1, 'Kota/Kabupaten wajib dipilih'),
  districtId: z.string().min(1, 'Kecamatan wajib dipilih'),
  villageId: z.string().min(1, 'Kelurahan/Desa wajib dipilih'),
  postalCode: z.string().regex(/^\d{5}$/, 'Kode pos terisi otomatis dari kelurahan'),
})

type AddressFormData = z.infer<typeof addressSchema>

// The map picker was removed from onboarding, but the backend contract still
// REQUIRES coordinates: CreateAddressDto validates latitude/longitude with
// @IsNumber (non-optional) and the Address columns are non-nullable, so this
// placeholder (Jakarta) is sent instead. This matches the previous behavior —
// the old map flow fell back to this exact value whenever the user never
// touched the map. Coverage gating and JNE pricing use region/postal-code;
// distance-priced couriers (Paxel) receive these placeholder coordinates,
// exactly as they did for no-pin submissions before.
const DEFAULT_LOCATION = { lat: -6.2088, lng: 106.8456 }

// Same internal-path guard used by the login page (avoids open redirects).
function safeRedirect(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

function OnboardingInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirect = params.get('redirect')
  const qc = useQueryClient()
  const { user } = useAuth()
  const createAddress = useCreateAddress()

  const [region, setRegion] = useState<RegionValue>({})

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    clearErrors,
  } = useForm<AddressFormData>({
    resolver: zodResolver(addressSchema),
    defaultValues: {
      recipientName: user?.name || '',
      provinceId: '',
      cityId: '',
      districtId: '',
      villageId: '',
      postalCode: '',
    },
  })

  // Push a chain-select selection into RHF.
  const applyRegion = useCallback(
    (next: RegionValue) => {
      setRegion(next)
      setValue('provinceId', next.provinceId ?? '', { shouldValidate: false })
      setValue('cityId', next.cityId ?? '', { shouldValidate: false })
      setValue('districtId', next.districtId ?? '', { shouldValidate: false })
      setValue('villageId', next.villageId ?? '', { shouldValidate: false })
      setValue('postalCode', next.postalCode ?? '', { shouldValidate: false })
      clearErrors(['provinceId', 'cityId', 'districtId', 'villageId', 'postalCode'])
    },
    [setValue, clearErrors],
  )

  const onSubmit = async (data: AddressFormData) => {
    try {

      // Real address creation (POST /users/me/addresses). The hook invalidates
      // qk.me + qk.addresses; the backend sets isOnboarded=true on this call.
      await createAddress.mutateAsync({
        label: 'Rumah',
        recipientName: data.recipientName,
        phone: data.phone,
        fullAddress: data.fullAddress,
        addressDetail: data.fullAddress,
        notes: data.notes,
        latitude: DEFAULT_LOCATION.lat,
        longitude: DEFAULT_LOCATION.lng,
        isDefault: true,
        provinceId: data.provinceId,
        cityId: data.cityId,
        districtId: data.districtId,
        villageId: data.villageId,
        postalCode: data.postalCode,
      })


      // Reflect isOnboarded=true synchronously BEFORE navigating so no stale
      // qk.me read can bounce the user back into onboarding.
      qc.setQueryData<User>(qk.me, (current) => (current ? { ...current, isOnboarded: true } : current))


      router.replace(safeRedirect(redirect))
    } catch {
      // Failure is surfaced by the global mutation-cache error toast.
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background border-b">
        <div className="container flex items-center justify-center h-14">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
              BMS
            </div>
            <span className="font-bold">Bakso Mas Sular</span>
          </div>
        </div>
      </header>

      <main className="container max-w-lg py-8 px-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          {/* Progress */}
          <div className="flex items-center justify-center gap-2 mb-8">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                <Check className="h-4 w-4" />
              </div>
              <span className="text-sm font-medium">Login</span>
            </div>
            <div className="w-12 h-0.5 bg-primary" />
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-medium">
                2
              </div>
              <span className="text-sm font-medium">Alamat</span>
            </div>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold mb-2">Atur Alamat Pengiriman</h1>
            <p className="text-muted-foreground">
              Tambahkan alamat untuk memudahkan pengiriman pesanan Anda
            </p>
          </div>

          {/* Address Form */}
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="recipientName">Nama Penerima</Label>
              <Input id="recipientName" placeholder="Masukkan nama penerima" {...register('recipientName')} />
              {errors.recipientName && (
                <p className="text-sm text-destructive">{errors.recipientName.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Nomor Telepon</Label>
              <Input id="phone" type="tel" placeholder="08xxxxxxxxxx" {...register('phone')} />
              {errors.phone && <p className="text-sm text-destructive">{errors.phone.message}</p>}
            </div>

            {/* Region hidden inputs (values driven by RegionFields via applyRegion). */}
            <input type="hidden" {...register('provinceId')} />
            <input type="hidden" {...register('cityId')} />
            <input type="hidden" {...register('districtId')} />
            <input type="hidden" {...register('villageId')} />
            <input type="hidden" {...register('postalCode')} />

            <RegionFields
              value={region}
              onChange={applyRegion}
              errors={{
                provinceId: errors.provinceId?.message,
                cityId: errors.cityId?.message,
                districtId: errors.districtId?.message,
                villageId: errors.villageId?.message,
                postalCode: errors.postalCode?.message,
              }}
            />

            <div className="space-y-2">
              <Label htmlFor="fullAddress">Alamat Lengkap (jalan, no. rumah, RT/RW)</Label>
              <Textarea
                id="fullAddress"
                placeholder="Nama jalan, nomor rumah, RT/RW"
                rows={3}
                {...register('fullAddress')}
              />
              {errors.fullAddress && <p className="text-sm text-destructive">{errors.fullAddress.message}</p>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Catatan Alamat (Opsional)</Label>
              <Input id="notes" placeholder="Contoh: Pagar warna biru, dekat masjid" {...register('notes')} />
            </div>

            <Button type="submit" className="w-full rounded-full" size="lg" disabled={createAddress.isPending}>
              {createAddress.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Menyimpan...
                </>
              ) : (
                'Simpan & Lanjutkan'
              )}
            </Button>
          </form>
        </motion.div>
      </main>
    </div>
  )
}

export default function OnboardingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <OnboardingInner />
    </Suspense>
  )
}
