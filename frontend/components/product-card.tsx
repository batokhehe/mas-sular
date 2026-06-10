'use client'

import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { Star, Heart, Plus, Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useFavoritesStore, useCartStore } from '@/lib/store'
import { formatPrice } from '@/lib/data'
import { type Product } from '@/lib/types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { getProductImageSrc } from '@/lib/product-images'

interface ProductCardProps {
  product: Product | (typeof import('@/lib/data').products)[0]
  index?: number
}

export function ProductCard({ product, index = 0 }: ProductCardProps) {
  const { toggleFavorite, isFavorite } = useFavoritesStore()
  const addItem = useCartStore((state) => state.addItem)
  const favorite = isFavorite(product.id)

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    addItem({
      product,
      quantity: 1,
      toppings: [],
      spicyLevel: 0,
    })
    toast.success(`${product.name} ditambahkan ke keranjang`)
  }

  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    toggleFavorite(product.id)
    toast.success(favorite ? 'Dihapus dari favorit' : 'Ditambahkan ke favorit')
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
    >
      <Link href={`/product/${product.id}`}>
        <motion.div
          whileHover={{ y: -4 }}
          className="group relative overflow-hidden rounded-2xl bg-card border shadow-sm transition-shadow hover:shadow-lg"
        >
          {/* Image Container */}
          <div className="relative aspect-square overflow-hidden bg-secondary/50">
            <Image
              src={getProductImageSrc(product)}
              alt={product.name}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
            />
            
            {/* Badges */}
            <div className="absolute top-2 left-2 flex flex-col gap-1">
              {product.isBestSeller && (
                <Badge className="bg-primary text-primary-foreground text-[10px] px-2">
                  Best Seller
                </Badge>
              )}
              {product.isNew && (
                <Badge variant="secondary" className="text-[10px] px-2">
                  Baru
                </Badge>
              )}
              {product.originalPrice && (
                <Badge variant="destructive" className="text-[10px] px-2">
                  -{Math.round((1 - product.price / product.originalPrice) * 100)}%
                </Badge>
              )}
            </div>

            {/* Favorite Button */}
            <button
              onClick={handleToggleFavorite}
              className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/80 backdrop-blur-sm transition-colors hover:bg-background"
            >
              <Heart
                className={cn(
                  'h-4 w-4 transition-colors',
                  favorite ? 'fill-primary text-primary' : 'text-muted-foreground'
                )}
              />
            </button>

            {/* Spicy Level Indicator */}
            {product.spicyLevel && product.spicyLevel > 0 && (
              <div className="absolute bottom-2 left-2 flex items-center gap-0.5 rounded-full bg-background/80 backdrop-blur-sm px-2 py-1">
                {Array.from({ length: product.spicyLevel }).map((_, i) => (
                  <Flame key={i} className="h-3 w-3 text-primary fill-primary" />
                ))}
              </div>
            )}
          </div>

          {/* Content */}
          <div className="p-3 sm:p-4">
            <h3 className="font-semibold text-sm sm:text-base line-clamp-2 leading-tight mb-1">
              {product.name}
            </h3>
            
            {/* Rating */}
            <div className="flex items-center gap-1 mb-2">
              <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
              <span className="text-xs font-medium">{product.rating}</span>
              <span className="text-xs text-muted-foreground">({product.reviewCount})</span>
            </div>

            {/* Price & Add Button */}
            <div className="flex items-end justify-between gap-2">
              <div>
                <p className="font-bold text-primary text-sm sm:text-base">
                  {formatPrice(product.price)}
                </p>
                {product.originalPrice && (
                  <p className="text-xs text-muted-foreground line-through">
                    {formatPrice(product.originalPrice)}
                  </p>
                )}
              </div>
              <Button
                size="icon"
                className="h-8 w-8 rounded-full shrink-0"
                onClick={handleAddToCart}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </motion.div>
      </Link>
    </motion.div>
  )
}
