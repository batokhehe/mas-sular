'use client'

import { useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Package,
  Clock,
  Truck,
  CheckCircle2,
  XCircle,
  ChevronRight,
  ShoppingBag,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { useAuthStore } from '@/lib/store'
import { sampleOrders, formatPrice, formatDate, type Order } from '@/lib/data'
import { cn } from '@/lib/utils'
import { getProductImageSrc } from '@/lib/product-images'

const statusConfig = {
  pending: {
    label: 'Menunggu',
    icon: Clock,
    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  },
  processing: {
    label: 'Diproses',
    icon: Package,
    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  },
  delivering: {
    label: 'Dikirim',
    icon: Truck,
    color: 'bg-primary/10 text-primary',
  },
  completed: {
    label: 'Selesai',
    icon: CheckCircle2,
    color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  },
  cancelled: {
    label: 'Dibatalkan',
    icon: XCircle,
    color: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  },
}

function OrderCard({ order, onClick }: { order: Order; onClick: () => void }) {
  const status = statusConfig[order.status]
  const StatusIcon = status.icon

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      onClick={onClick}
      className="bg-card border rounded-2xl p-4 cursor-pointer transition-shadow hover:shadow-md"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="font-semibold text-sm">{order.orderNumber}</p>
          <p className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</p>
        </div>
        <Badge className={cn('gap-1', status.color)}>
          <StatusIcon className="h-3 w-3" />
          {status.label}
        </Badge>
      </div>

      {/* Items Preview */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex -space-x-2">
          {order.items.slice(0, 3).map((item, i) => (
            <div
              key={i}
              className="relative h-12 w-12 rounded-lg overflow-hidden bg-secondary border-2 border-background"
            >
              <Image
                src={getProductImageSrc(item.product)}
                alt={item.product.name}
                fill
                className="object-cover"
              />
            </div>
          ))}
          {order.items.length > 3 && (
            <div className="h-12 w-12 rounded-lg bg-secondary flex items-center justify-center text-xs font-medium border-2 border-background">
              +{order.items.length - 3}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm line-clamp-1">
            {order.items.map((i) => i.product.name).join(', ')}
          </p>
          <p className="text-xs text-muted-foreground">
            {order.items.reduce((sum, i) => sum + i.quantity, 0)} item
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t">
        <div>
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="font-semibold text-primary">{formatPrice(order.totalPrice)}</p>
        </div>
        <ChevronRight className="h-5 w-5 text-muted-foreground" />
      </div>
    </motion.div>
  )
}

function OrderDetailModal({ order, open, onClose }: { order: Order | null; open: boolean; onClose: () => void }) {
  if (!order) return null

  const status = statusConfig[order.status]
  const StatusIcon = status.icon

  const timeline = [
    { status: 'pending', label: 'Pesanan Dibuat', done: true },
    { status: 'processing', label: 'Pesanan Diproses', done: ['processing', 'delivering', 'completed'].includes(order.status) },
    { status: 'delivering', label: 'Dalam Pengiriman', done: ['delivering', 'completed'].includes(order.status) },
    { status: 'completed', label: 'Pesanan Selesai', done: order.status === 'completed' },
  ]

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Detail Pesanan</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Order Info */}
          <div className="flex items-start justify-between">
            <div>
              <p className="font-semibold">{order.orderNumber}</p>
              <p className="text-sm text-muted-foreground">{formatDate(order.createdAt)}</p>
            </div>
            <Badge className={cn('gap-1', status.color)}>
              <StatusIcon className="h-3 w-3" />
              {status.label}
            </Badge>
          </div>

          {/* Timeline */}
          <div className="space-y-3">
            <h4 className="font-medium text-sm">Status Pesanan</h4>
            <div className="space-y-3">
              {timeline.map((item, index) => (
                <div key={item.status} className="flex items-center gap-3">
                  <div className={cn(
                    'h-6 w-6 rounded-full flex items-center justify-center text-xs',
                    item.done ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'
                  )}>
                    {item.done ? <CheckCircle2 className="h-4 w-4" /> : index + 1}
                  </div>
                  <span className={cn('text-sm', item.done ? 'font-medium' : 'text-muted-foreground')}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Items */}
          <div className="space-y-3">
            <h4 className="font-medium text-sm">Item Pesanan</h4>
            <div className="space-y-2">
              {order.items.map((item, index) => (
                <div key={index} className="flex gap-3">
                  <div className="relative h-14 w-14 rounded-lg overflow-hidden bg-secondary shrink-0">
                    <Image
                      src={getProductImageSrc(item.product)}
                      alt={item.product.name}
                      fill
                      className="object-cover"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm line-clamp-1">{item.product.name}</p>
                    <p className="text-xs text-muted-foreground">x{item.quantity}</p>
                  </div>
                  <p className="text-sm font-medium">
                    {formatPrice(item.product.price * item.quantity)}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Address */}
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Alamat Pengiriman</h4>
            <div className="p-3 bg-secondary rounded-xl text-sm">
              <p className="font-medium">{order.address.recipientName}</p>
              <p className="text-muted-foreground">{order.address.phone}</p>
              <p className="text-muted-foreground">{order.address.fullAddress}</p>
            </div>
          </div>

          {/* Payment Summary */}
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Ringkasan Pembayaran</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{formatPrice(order.totalPrice - order.deliveryFee)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Ongkos Kirim</span>
                <span>{formatPrice(order.deliveryFee)}</span>
              </div>
              <div className="flex justify-between font-semibold pt-2 border-t">
                <span>Total</span>
                <span className="text-primary">{formatPrice(order.totalPrice)}</span>
              </div>
            </div>
          </div>

          <Button className="w-full rounded-full" onClick={onClose}>
            Tutup
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function OrdersPage() {
  const router = useRouter()
  const { isAuthenticated } = useAuthStore()
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [activeTab, setActiveTab] = useState('all')

  const filteredOrders = activeTab === 'all'
    ? sampleOrders
    : sampleOrders.filter((o) => o.status === activeTab)

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen pb-20 md:pb-0">
        <Navbar />
        <main className="container max-w-2xl py-8">
          <div className="text-center py-12">
            <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
              <ShoppingBag className="h-8 w-8 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Belum Login</h2>
            <p className="text-muted-foreground mb-6">
              Masuk untuk melihat riwayat pesanan Anda
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
        <div className="flex items-center h-14 px-4 gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Pesanan Saya</h1>
        </div>
      </header>

      <main className="container max-w-2xl py-4 md:py-8">
        <h1 className="hidden md:block text-2xl font-bold mb-6">Pesanan Saya</h1>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full justify-start mb-4 h-auto p-1 bg-secondary overflow-x-auto">
            <TabsTrigger value="all" className="rounded-full text-xs">Semua</TabsTrigger>
            <TabsTrigger value="pending" className="rounded-full text-xs">Menunggu</TabsTrigger>
            <TabsTrigger value="processing" className="rounded-full text-xs">Diproses</TabsTrigger>
            <TabsTrigger value="delivering" className="rounded-full text-xs">Dikirim</TabsTrigger>
            <TabsTrigger value="completed" className="rounded-full text-xs">Selesai</TabsTrigger>
          </TabsList>

          <TabsContent value={activeTab} className="mt-0">
            {filteredOrders.length > 0 ? (
              <div className="space-y-3">
                {filteredOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    onClick={() => setSelectedOrder(order)}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-secondary flex items-center justify-center">
                  <Package className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground">Belum ada pesanan</p>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </main>

      <OrderDetailModal
        order={selectedOrder}
        open={!!selectedOrder}
        onClose={() => setSelectedOrder(null)}
      />

      <BottomNav />
    </div>
  )
}
