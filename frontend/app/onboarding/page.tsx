'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Script from 'next/script'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check, Loader2, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { useAuth } from '@/lib/auth/auth-context'
import { useCreateAddress } from '@/lib/query/hooks/use-addresses'
import { qk } from '@/lib/query/keys'
import type { User } from '@/lib/types/models'
import { RegionFields } from '@/components/address/region-fields'
import {
  partsFromGoogleComponents,
  resolveRegionFromGeocode,
  type RegionValue,
} from '@/lib/address/region-value'

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

const DEFAULT_LOCATION = { lat: -6.2088, lng: 106.8456 }
const googleMapsApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

type LatLng = { lat: number; lng: number }

declare global {
  interface Window {
    google?: any
  }
}

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

  const [mapLocation, setMapLocation] = useState<LatLng | null>(null)
  const [isMapReady, setIsMapReady] = useState(false)
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [isLocating, setIsLocating] = useState(false)
  const [region, setRegion] = useState<RegionValue>({})
  const mapRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<any>(null)
  const markerRef = useRef<any>(null)
  const geocoderRef = useRef<any>(null)

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

  // Push a chain-select selection into RHF (used by both manual selection and the
  // reverse-geocode auto-fill).
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

  const reverseGeocodeLocation = useCallback(
    (location: LatLng) => {
      if (!geocoderRef.current) return

      setIsGeocoding(true)
      geocoderRef.current.geocode({ location }, (results: any[], status: string) => {
        if (status === 'OK' && results?.[0]?.formatted_address) {
          setValue('fullAddress', results[0].formatted_address, { shouldValidate: true })
          // Best-effort: resolve Google's component names → master-table ids so the
          // chain-select and postal code auto-fill without manual selection.
          const parts = partsFromGoogleComponents(results[0].address_components ?? [])
          resolveRegionFromGeocode(parts)
            .then((resolved) => {
              if (resolved.provinceId) applyRegion(resolved)
            })
            .catch(() => undefined)
            .finally(() => setIsGeocoding(false))
          return
        }

        setIsGeocoding(false)
        toast.error('Alamat dari lokasi ini tidak ditemukan')
      })
    },
    [setValue, applyRegion],
  )

  const selectMapLocation = useCallback((location: LatLng, shouldReverseGeocode = true) => {
    setMapLocation(location)

    if (mapInstanceRef.current) {
      mapInstanceRef.current.panTo(location)
      mapInstanceRef.current.setZoom(16)
    }

    if (markerRef.current) {
      markerRef.current.setPosition(location)
    }

    if (shouldReverseGeocode) {
      reverseGeocodeLocation(location)
    }
  }, [reverseGeocodeLocation])

  const initializeMap = useCallback(() => {
    if (!mapRef.current || !window.google?.maps || mapInstanceRef.current) return

    const center = mapLocation || DEFAULT_LOCATION
    geocoderRef.current = new window.google.maps.Geocoder()
    mapInstanceRef.current = new window.google.maps.Map(mapRef.current, {
      center,
      zoom: mapLocation ? 16 : 12,
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: true,
      mapTypeControl: false,
      streetViewControl: false,
    })

    markerRef.current = new window.google.maps.Marker({
      position: center,
      map: mapInstanceRef.current,
      draggable: true,
      title: 'Lokasi pengiriman',
    })

    mapInstanceRef.current.addListener('click', (event: any) => {
      if (!event.latLng) return
      selectMapLocation({
        lat: event.latLng.lat(),
        lng: event.latLng.lng(),
      })
    })

    markerRef.current.addListener('dragend', (event: any) => {
      if (!event.latLng) return
      selectMapLocation({
        lat: event.latLng.lat(),
        lng: event.latLng.lng(),
      })
    })

    setIsMapReady(true)
  }, [mapLocation, selectMapLocation])

  useEffect(() => {
    if (googleMapsApiKey && window.google?.maps && mapRef.current && !mapInstanceRef.current) {
      initializeMap()
    }
  }, [initializeMap])

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Browser Anda tidak mendukung geolokasi')
      return
    }

    setIsLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        selectMapLocation({ lat: latitude, lng: longitude }, Boolean(geocoderRef.current))
        setIsLocating(false)
        toast.success('Lokasi berhasil didapatkan')
      },
      () => {
        setIsLocating(false)
        toast.error('Gagal mendapatkan lokasi. Pastikan GPS aktif.')
      },
      { enableHighAccuracy: true },
    )
  }

  const onSubmit = async (data: AddressFormData) => {
    try {
      // ── TEMP RCA instrumentation — remove after verification ───────────────
      console.debug('[RCA] me.addresses BEFORE create  :', qc.getQueryData<User>(qk.me)?.addresses?.length,
        '| addresses cache:', (qc.getQueryData(qk.addresses) as unknown[] | undefined)?.length)
      // ───────────────────────────────────────────────────────────────────────

      // Real address creation (POST /users/me/addresses). The hook invalidates
      // qk.me + qk.addresses; the backend sets isOnboarded=true on this call.
      await createAddress.mutateAsync({
        label: 'Rumah',
        recipientName: data.recipientName,
        phone: data.phone,
        fullAddress: data.fullAddress,
        addressDetail: data.fullAddress,
        notes: data.notes,
        latitude: mapLocation?.lat ?? DEFAULT_LOCATION.lat,
        longitude: mapLocation?.lng ?? DEFAULT_LOCATION.lng,
        isDefault: true,
        provinceId: data.provinceId,
        cityId: data.cityId,
        districtId: data.districtId,
        villageId: data.villageId,
        postalCode: data.postalCode,
      })

      // ── TEMP RCA instrumentation — remove after verification ───────────────
      console.debug('[RCA] me.addresses AFTER mutate+invalidate:', qc.getQueryData<User>(qk.me)?.addresses?.length)
      // ───────────────────────────────────────────────────────────────────────

      // Reflect isOnboarded=true synchronously BEFORE navigating so no stale
      // qk.me read can bounce the user back into onboarding.
      qc.setQueryData<User>(qk.me, (current) => (current ? { ...current, isOnboarded: true } : current))

      // ── TEMP RCA instrumentation — remove after verification ───────────────
      console.debug('[RCA] me.addresses AFTER setQueryData :', qc.getQueryData<User>(qk.me)?.addresses?.length,
        '| addresses cache:', (qc.getQueryData(qk.addresses) as unknown[] | undefined)?.length)
      // ───────────────────────────────────────────────────────────────────────

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

          {googleMapsApiKey && (
            <Script
              src={`https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}`}
              strategy="afterInteractive"
              onLoad={initializeMap}
              onError={() => toast.error('Gagal memuat Google Maps')}
            />
          )}

          {/* Map */}
          <div className="relative h-56 rounded-lg overflow-hidden bg-secondary mb-3 border">
            {googleMapsApiKey ? (
              <>
                <div ref={mapRef} className="absolute inset-0" />
                {!isMapReady && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-secondary">
                    <Loader2 className="h-7 w-7 animate-spin text-primary mb-2" />
                    <p className="text-sm text-muted-foreground">Memuat Google Maps...</p>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
                <MapPin className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Google Maps belum dikonfigurasi</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Tambahkan NEXT_PUBLIC_GOOGLE_MAPS_API_KEY untuk memilih titik pengiriman di peta.
                </p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mb-6 text-xs text-muted-foreground">
            <span>
              {mapLocation
                ? `${mapLocation.lat.toFixed(5)}, ${mapLocation.lng.toFixed(5)}`
                : 'Ketuk peta atau gunakan lokasi saat ini'}
            </span>
            {isGeocoding && (
              <span className="inline-flex items-center gap-1 whitespace-nowrap">
                <Loader2 className="h-3 w-3 animate-spin" />
                Membaca alamat
              </span>
            )}
          </div>

          <Button
            variant="outline"
            className="w-full mb-6 rounded-full"
            onClick={handleGetLocation}
            disabled={isLocating}
          >
            {isLocating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Mencari lokasi...
              </>
            ) : (
              <>
                <MapPin className="mr-2 h-4 w-4" />
                Gunakan Lokasi Saat Ini
              </>
            )}
          </Button>

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
