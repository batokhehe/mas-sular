'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  User,
  MapPin,
  Package,
  Heart,
  Settings,
  LogOut,
  ChevronRight,
  Plus,
  Edit2,
  Trash2,
  Moon,
  Sun,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { useAuthStore, useAddressStore, useFavoritesStore, useCartStore } from '@/lib/store'
import { sampleOrders, products } from '@/lib/data'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'

export default function ProfilePage() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const { user, isAuthenticated, logout } = useAuthStore()
  const { addresses, removeAddress } = useAddressStore()
  const { favorites } = useFavoritesStore()
  const clearCart = useCartStore((state) => state.clearCart)

  const [showAddresses, setShowAddresses] = useState(false)

  const stats = {
    orders: sampleOrders.length,
    favorites: favorites.length,
    addresses: addresses.length,
  }

  const handleLogout = () => {
    logout()
    clearCart()
    router.push('/')
    toast.success('Berhasil keluar')
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen pb-20 md:pb-0">
        <Navbar />
        <main className="container max-w-2xl py-8">
          <div className="text-center py-12">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
              <User className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Belum Login</h2>
            <p className="text-muted-foreground mb-6">
              Masuk untuk mengakses profil Anda
            </p>
            <Link href="/login">
              <Button className="rounded-full">Masuk</Button>
            </Link>
          </div>
        </main>
        <BottomNav />
      </div>
    )
  }

  return (
    <div className="min-h-screen pb-20 md:pb-0">
      <div className="hidden md:block">
        <Navbar />
      </div>

      {/* Mobile Header */}
      <header className="sticky top-0 z-50 md:hidden bg-background border-b">
        <div className="flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.back()}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="font-semibold">Profil</h1>
          </div>
          <Button variant="ghost" size="icon">
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <main className="container max-w-2xl py-4 md:py-8">
        {/* Profile Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-4 p-4 bg-card border rounded-2xl mb-6"
        >
          <div className="relative">
            {user?.avatar ? (
              <img
                src={user.avatar}
                alt={user.name}
                className="h-16 w-16 rounded-full object-cover"
              />
            ) : (
              <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-8 w-8 text-primary" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-bold text-lg truncate">{user?.name}</h2>
            <p className="text-sm text-muted-foreground truncate">{user?.email}</p>
          </div>
          <Button variant="ghost" size="icon">
            <Edit2 className="h-4 w-4" />
          </Button>
        </motion.div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {[
            { label: 'Pesanan', value: stats.orders, icon: Package },
            { label: 'Favorit', value: stats.favorites, icon: Heart },
            { label: 'Alamat', value: stats.addresses, icon: MapPin },
          ].map((stat) => {
            const Icon = stat.icon
            return (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="bg-card border rounded-xl p-4 text-center"
              >
                <Icon className="h-5 w-5 mx-auto mb-2 text-primary" />
                <p className="text-2xl font-bold">{stat.value}</p>
                <p className="text-xs text-muted-foreground">{stat.label}</p>
              </motion.div>
            )
          })}
        </div>

        {/* Menu Items */}
        <div className="space-y-3">
          {/* Addresses Section */}
          <div className="bg-card border rounded-2xl overflow-hidden">
            <button
              onClick={() => setShowAddresses(!showAddresses)}
              className="w-full flex items-center justify-between p-4 hover:bg-accent transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <MapPin className="h-5 w-5 text-primary" />
                </div>
                <div className="text-left">
                  <p className="font-medium">Alamat Tersimpan</p>
                  <p className="text-sm text-muted-foreground">{addresses.length} alamat</p>
                </div>
              </div>
              <ChevronRight className={`h-5 w-5 text-muted-foreground transition-transform ${showAddresses ? 'rotate-90' : ''}`} />
            </button>

            {showAddresses && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                className="border-t"
              >
                <div className="p-4 space-y-3">
                  {addresses.map((address) => (
                    <div
                      key={address.id}
                      className="flex items-start gap-3 p-3 bg-secondary/50 rounded-xl"
                    >
                      <MapPin className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{address.label}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {address.fullAddress}
                        </p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Hapus Alamat</AlertDialogTitle>
                            <AlertDialogDescription>
                              Apakah Anda yakin ingin menghapus alamat ini?
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Batal</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeAddress(address.id)}>
                              Hapus
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ))}
                  <Link href="/onboarding">
                    <Button variant="outline" className="w-full rounded-full">
                      <Plus className="mr-2 h-4 w-4" />
                      Tambah Alamat Baru
                    </Button>
                  </Link>
                </div>
              </motion.div>
            )}
          </div>

          {/* Orders */}
          <Link href="/orders">
            <div className="flex items-center justify-between p-4 bg-card border rounded-2xl hover:bg-accent transition-colors">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Package className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Riwayat Pesanan</p>
                  <p className="text-sm text-muted-foreground">Lihat semua pesanan Anda</p>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            </div>
          </Link>

          {/* Favorites */}
          <Link href="/menu">
            <div className="flex items-center justify-between p-4 bg-card border rounded-2xl hover:bg-accent transition-colors">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Heart className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">Favorit</p>
                  <p className="text-sm text-muted-foreground">{favorites.length} produk disimpan</p>
                </div>
              </div>
              <ChevronRight className="h-5 w-5 text-muted-foreground" />
            </div>
          </Link>

          {/* Dark Mode Toggle */}
          <div className="flex items-center justify-between p-4 bg-card border rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                {theme === 'dark' ? (
                  <Moon className="h-5 w-5 text-primary" />
                ) : (
                  <Sun className="h-5 w-5 text-primary" />
                )}
              </div>
              <div>
                <p className="font-medium">Mode Gelap</p>
                <p className="text-sm text-muted-foreground">Ubah tampilan aplikasi</p>
              </div>
            </div>
            <Switch
              checked={theme === 'dark'}
              onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
            />
          </div>

          {/* Logout */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button className="w-full flex items-center justify-between p-4 bg-card border rounded-2xl hover:bg-accent transition-colors text-left">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-destructive/10 flex items-center justify-center">
                    <LogOut className="h-5 w-5 text-destructive" />
                  </div>
                  <div>
                    <p className="font-medium text-destructive">Keluar</p>
                    <p className="text-sm text-muted-foreground">Keluar dari akun Anda</p>
                  </div>
                </div>
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Keluar dari Akun</AlertDialogTitle>
                <AlertDialogDescription>
                  Apakah Anda yakin ingin keluar dari akun? Keranjang belanja Anda akan dikosongkan.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Batal</AlertDialogCancel>
                <AlertDialogAction onClick={handleLogout} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                  Keluar
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </main>

      <BottomNav />
    </div>
  )
}
