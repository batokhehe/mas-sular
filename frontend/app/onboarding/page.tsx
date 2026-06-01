'use client'

import { useState } from 'react'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { MapPin, Loader2, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { userApi } from '@/lib/api'
import { useAddressStore, useAuthStore } from '@/lib/store'
import { toast } from 'sonner'

const addressSchema = z.object({
  recipientName: z.string().min(2, 'Nama penerima minimal 2 karakter'),
  phone: z.string().min(10, 'Nomor telepon tidak valid').max(15),
  fullAddress: z.string().min(10, 'Alamat lengkap minimal 10 karakter'),
  notes: z.string().optional(),
})

type AddressFormData = z.infer<typeof addressSchema>

export default function OnboardingPage() {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [mapLocation, setMapLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [isLocating, setIsLocating] = useState(false)
  
  const addAddress = useAddressStore((state) => state.addAddress)
  const completeOnboarding = useAuthStore((state) => state.completeOnboarding)
  const { isAuthenticated, user } = useAuthStore()

  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/login')
    }
  }, [isAuthenticated, router])

  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
  } = useForm<AddressFormData>({
    resolver: zodResolver(addressSchema),
    defaultValues: {
      recipientName: user?.name || '',
    },
  })

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      toast.error('Browser Anda tidak mendukung geolokasi')
      return
    }

    setIsLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        setMapLocation({ lat: latitude, lng: longitude })
        setIsLocating(false)
        toast.success('Lokasi berhasil didapatkan')
        
        // Simulate reverse geocoding
        setValue('fullAddress', `Jl. Contoh No. ${Math.floor(Math.random() * 100)}, Jakarta Pusat, DKI Jakarta 10110`)
      },
      (error) => {
        setIsLocating(false)
        toast.error('Gagal mendapatkan lokasi. Pastikan GPS aktif.')
      },
      { enableHighAccuracy: true }
    )
  }

  const onSubmit = async (data: AddressFormData) => {
    setIsSubmitting(true)

    try {
      const address = await userApi.createAddress({
        label: 'Rumah',
        recipientName: data.recipientName,
        phone: data.phone,
        fullAddress: data.fullAddress,
        notes: data.notes,
        latitude: mapLocation?.lat || -6.2088,
        longitude: mapLocation?.lng || 106.8456,
        isDefault: true,
      })

      addAddress({
        id: address.id,
        label: address.label,
        recipientName: address.recipientName,
        phone: address.phone,
        fullAddress: address.fullAddress,
        notes: address.notes,
        latitude: Number(address.latitude),
        longitude: Number(address.longitude),
        isDefault: address.isDefault,
      })

      completeOnboarding()
      toast.success('Alamat berhasil disimpan!')
      router.push('/')
    } catch (error) {
      console.error('Failed to save address', error)
      toast.error('Gagal menyimpan alamat. Silakan coba lagi.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Prevent server-side router actions by redirecting on the client
  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background border-b">
        <div className="container flex items-center justify-center h-14">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
              BN
            </div>
            <span className="font-bold">Baso Nusantara</span>
          </div>
        </div>
      </header>

      <main className="container max-w-lg py-8 px-4">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
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

          {/* Map Placeholder */}
          <div className="relative h-48 rounded-2xl overflow-hidden bg-secondary mb-6">
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {mapLocation ? (
                <>
                  <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center mb-2">
                    <MapPin className="h-6 w-6 text-primary" />
                  </div>
                  <p className="text-sm font-medium">Lokasi Terpilih</p>
                  <p className="text-xs text-muted-foreground">
                    {mapLocation.lat.toFixed(4)}, {mapLocation.lng.toFixed(4)}
                  </p>
                </>
              ) : (
                <>
                  <MapPin className="h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    Pilih lokasi untuk pengiriman
                  </p>
                </>
              )}
            </div>
            
            {/* Grid overlay for map feel */}
            <div className="absolute inset-0 opacity-20">
              <div className="w-full h-full" style={{
                backgroundImage: 'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
                backgroundSize: '40px 40px',
              }} />
            </div>
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
              <Input
                id="recipientName"
                placeholder="Masukkan nama penerima"
                {...register('recipientName')}
              />
              {errors.recipientName && (
                <p className="text-sm text-destructive">{errors.recipientName.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Nomor Telepon</Label>
              <Input
                id="phone"
                type="tel"
                placeholder="08xxxxxxxxxx"
                {...register('phone')}
              />
              {errors.phone && (
                <p className="text-sm text-destructive">{errors.phone.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="fullAddress">Alamat Lengkap</Label>
              <Textarea
                id="fullAddress"
                placeholder="Nama jalan, nomor rumah, RT/RW, kelurahan, kecamatan, kota"
                rows={3}
                {...register('fullAddress')}
              />
              {errors.fullAddress && (
                <p className="text-sm text-destructive">{errors.fullAddress.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Catatan Alamat (Opsional)</Label>
              <Input
                id="notes"
                placeholder="Contoh: Pagar warna biru, dekat masjid"
                {...register('notes')}
              />
            </div>

            <Button
              type="submit"
              className="w-full rounded-full"
              size="lg"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
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
