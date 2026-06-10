'use client'

import { useState, use } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Star,
  Heart,
  Minus,
  Plus,
  Flame,
  ShoppingCart,
  Share2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Navbar } from '@/components/navbar'
import { BottomNav } from '@/components/bottom-nav'
import { ProductCard } from '@/components/product-card'
import { formatPrice } from '@/lib/data'
import { useProduct, useProducts, useToppings } from '@/hooks/api'
import { useCartStore, useFavoritesStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Topping } from '@/lib/types'
import { getProductImageSrc } from '@/lib/product-images'

interface ProductPageProps {
  params: Promise<{ id: string }>
}

export default function ProductPage({ params }: ProductPageProps) {
  const { id } = use(params)
  const router = useRouter()
  
  // Fetch product from API
  const { data: product, isLoading, error } = useProduct(id)
  const { data: toppings = [] } = useToppings()
  
  // Fetch related products (same category)
  const { data: allProducts = [] } = useProducts()
  
  const [quantity, setQuantity] = useState(1)
  const [selectedToppings, setSelectedToppings] = useState<Topping[]>([])
  const [spicyLevel, setSpicyLevel] = useState(0)
  const [notes, setNotes] = useState('')

  const addItem = useCartStore((state) => state.addItem)
  const { toggleFavorite, isFavorite } = useFavoritesStore()
  const favorite = product ? isFavorite(product.id) : false

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-2">Produk tidak ditemukan</h1>
          <Link href="/menu">
            <Button>Kembali ke Menu</Button>
          </Link>
        </div>
      </div>
    )
  }

  if (isLoading || !product) {
    return (
      <div className="min-h-screen pb-32 md:pb-0">
        <div className="hidden md:block">
          <Navbar />
        </div>
        <main className="container max-w-5xl py-4 md:py-8">
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="aspect-square rounded-2xl bg-secondary/50 animate-pulse" />
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-4 bg-secondary/50 rounded animate-pulse" />
              ))}
            </div>
          </div>
        </main>
      </div>
    )
  }

  const relatedProducts = allProducts
    .filter((p) => p.categoryId === product.categoryId && p.id !== product.id)
    .slice(0, 4)

  const toppingsTotal = selectedToppings.reduce((sum, t) => sum + t.price, 0)
  const itemTotal = (product.price + toppingsTotal) * quantity

  const handleToggleTopping = (topping: Topping) => {
    setSelectedToppings((prev) =>
      prev.find((t) => t.id === topping.id)
        ? prev.filter((t) => t.id !== topping.id)
        : [...prev, topping]
    )
  }

  const handleAddToCart = () => {
    // Convert API product to cart item format
    const cartProduct = {
      id: product.id,
      slug: product.slug,
      sku: product.sku,
      name: product.name,
      description: product.description,
      price: product.price,
      originalPrice: product.originalPrice,
      image: getProductImageSrc(product),
      imageUrl: product.imageUrl,
      rating: product.rating,
      reviewCount: product.reviewCount,
      spicyLevel: product.spicyLevel,
      isBestSeller: product.isBestSeller,
      isNew: product.isNew,
      stock: product.stock,
      category: '', // backwards compat
    }
    
    addItem({
      product: cartProduct,
      quantity,
      toppings: selectedToppings,
      spicyLevel,
      notes: notes || undefined,
    })
    toast.success(`${product.name} ditambahkan ke keranjang`)
  }

  const spicyLevels = [0, 1, 2, 3, 4, 5]
  const isMercon = product.name.toLowerCase().includes('mercon') || product.spicyLevel && product.spicyLevel > 0

  return (
    <div className="min-h-screen pb-32 md:pb-0">
      {/* Desktop Navbar */}
      <div className="hidden md:block">
        <Navbar />
      </div>

      {/* Mobile Header */}
      <header className="sticky top-0 z-50 md:hidden bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b">
        <div className="flex items-center justify-between h-14 px-4">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold truncate max-w-[200px]">Detail Produk</h1>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon">
              <Share2 className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleFavorite(product.id)}
            >
              <Heart
                className={cn(
                  'h-5 w-5',
                  favorite && 'fill-primary text-primary'
                )}
              />
            </Button>
          </div>
        </div>
      </header>

      <main className="container max-w-5xl py-4 md:py-8">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Image Section */}
          <div className="space-y-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="relative aspect-square rounded-2xl overflow-hidden bg-secondary/50"
            >
              <Image
                src={getProductImageSrc(product)}
                alt={product.name}
                fill
                className="object-cover"
                priority
              />
              
              {/* Badges */}
              <div className="absolute top-4 left-4 flex flex-col gap-2">
                {product.isBestSeller && (
                  <Badge className="bg-primary text-primary-foreground">
                    Best Seller
                  </Badge>
                )}
                {product.isNew && (
                  <Badge variant="secondary">Baru</Badge>
                )}
                {product.originalPrice && (
                  <Badge variant="destructive">
                    -{Math.round((1 - product.price / product.originalPrice) * 100)}%
                  </Badge>
                )}
              </div>

              {/* Desktop Favorite Button */}
              <button
                onClick={() => toggleFavorite(product.id)}
                className="hidden md:flex absolute top-4 right-4 h-10 w-10 items-center justify-center rounded-full bg-background/80 backdrop-blur-sm transition-colors hover:bg-background"
              >
                <Heart
                  className={cn(
                    'h-5 w-5',
                    favorite && 'fill-primary text-primary'
                  )}
                />
              </button>
            </motion.div>
          </div>

          {/* Details Section */}
          <div className="space-y-6">
            {/* Header */}
            <div>
              <div className="flex items-start justify-between gap-4 mb-2">
                <h1 className="text-2xl sm:text-3xl font-bold">{product.name}</h1>
              </div>
              
              <div className="flex items-center gap-3 mb-4">
                <div className="flex items-center gap-1">
                  <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  <span className="font-medium">{product.rating}</span>
                  <span className="text-muted-foreground">
                    ({product.reviewCount} ulasan)
                  </span>
                </div>
                {product.spicyLevel && product.spicyLevel > 0 && (
                  <div className="flex items-center gap-1">
                    {Array.from({ length: product.spicyLevel }).map((_, i) => (
                      <Flame key={i} className="h-4 w-4 text-primary fill-primary" />
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-baseline gap-3">
                <span className="text-2xl sm:text-3xl font-bold text-primary">
                  {formatPrice(product.price)}
                </span>
                {product.originalPrice && (
                  <span className="text-lg text-muted-foreground line-through">
                    {formatPrice(product.originalPrice)}
                  </span>
                )}
              </div>
            </div>

            {/* Description */}
            <div>
              <h3 className="font-semibold mb-2">Deskripsi</h3>
              <p className="text-muted-foreground">{product.description}</p>
            </div>

            {/* Spicy Level Selection */}
            {isMercon && (
              <div>
                <h3 className="font-semibold mb-3">Level Kepedasan</h3>
                <div className="flex flex-wrap gap-2">
                  {spicyLevels.map((level) => (
                    <button
                      key={level}
                      onClick={() => setSpicyLevel(level)}
                      className={cn(
                        'flex items-center gap-1 px-3 py-2 rounded-full border transition-colors',
                        spicyLevel === level
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'hover:border-primary/50'
                      )}
                    >
                      {level === 0 ? (
                        <span className="text-sm">Tidak Pedas</span>
                      ) : (
                        <>
                          {Array.from({ length: level }).map((_, i) => (
                            <Flame key={i} className="h-4 w-4 text-primary fill-primary" />
                          ))}
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Toppings */}
            {toppings.length > 0 && (
              <div>
                <h3 className="font-semibold mb-3">Tambahan (Opsional)</h3>
                <div className="grid grid-cols-2 gap-2">
                  {toppings.map((topping) => {
                    const isSelected = selectedToppings.some((t) => t.id === topping.id)
                    return (
                      <button
                        key={topping.id}
                        onClick={() => handleToggleTopping(topping)}
                        className={cn(
                          'flex items-center justify-between p-3 rounded-xl border transition-colors text-left',
                          isSelected
                            ? 'border-primary bg-primary/5'
                            : 'hover:border-primary/50'
                        )}
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox checked={isSelected} />
                          <span className="text-sm font-medium">{topping.name}</span>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          +{formatPrice(topping.price)}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <h3 className="font-semibold mb-2">Catatan</h3>
              <Textarea
                placeholder="Contoh: Kuahnya banyakin, tolong pisahkan sambal..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="resize-none"
                rows={3}
              />
            </div>

            {/* Quantity & Add to Cart - Desktop */}
            <div className="hidden md:flex items-center gap-4 pt-4 border-t">
              <div className="flex items-center gap-3 bg-secondary rounded-full p-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-8 text-center font-semibold">{quantity}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 rounded-full"
                  onClick={() => setQuantity(quantity + 1)}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <Button
                size="lg"
                className="flex-1 rounded-full"
                onClick={handleAddToCart}
              >
                <ShoppingCart className="mr-2 h-5 w-5" />
                Tambah - {formatPrice(itemTotal)}
              </Button>
            </div>
          </div>
        </div>

        {/* Related Products */}
        {relatedProducts.length > 0 && (
          <section className="mt-12">
            <h2 className="text-xl font-bold mb-4">Produk Serupa</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              {relatedProducts.map((p, i) => (
                <ProductCard key={p.id} product={p} index={i} />
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Mobile Sticky Footer */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t p-4 md:hidden">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-secondary rounded-full p-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
              onClick={() => setQuantity(Math.max(1, quantity - 1))}
            >
              <Minus className="h-4 w-4" />
            </Button>
            <span className="w-6 text-center font-semibold text-sm">{quantity}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
              onClick={() => setQuantity(quantity + 1)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <Button className="flex-1 rounded-full" onClick={handleAddToCart}>
            <ShoppingCart className="mr-2 h-4 w-4" />
            Tambah - {formatPrice(itemTotal)}
          </Button>
        </div>
      </div>

      <div className="hidden md:block">
        <BottomNav />
      </div>
    </div>
  )
}
