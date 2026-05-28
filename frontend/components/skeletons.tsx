'use client'

import { Skeleton } from '@/components/ui/skeleton'

export function ProductCardSkeleton() {
  return (
    <div className="rounded-2xl bg-card border overflow-hidden">
      <Skeleton className="aspect-square w-full" />
      <div className="p-3 sm:p-4">
        <Skeleton className="h-4 w-3/4 mb-2" />
        <Skeleton className="h-3 w-1/2 mb-3" />
        <div className="flex items-end justify-between">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </div>
    </div>
  )
}

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  )
}

export function HeroSkeleton() {
  return (
    <div className="bg-secondary/30 py-8 sm:py-12 lg:py-16">
      <div className="container">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12 items-center">
          <div className="text-center lg:text-left">
            <Skeleton className="h-6 w-40 mx-auto lg:mx-0 mb-4 rounded-full" />
            <Skeleton className="h-12 w-full max-w-md mx-auto lg:mx-0 mb-2" />
            <Skeleton className="h-12 w-3/4 max-w-sm mx-auto lg:mx-0 mb-4" />
            <Skeleton className="h-5 w-full max-w-lg mx-auto lg:mx-0 mb-2" />
            <Skeleton className="h-5 w-2/3 max-w-md mx-auto lg:mx-0 mb-6" />
            <div className="flex gap-3 justify-center lg:justify-start">
              <Skeleton className="h-11 w-36 rounded-full" />
              <Skeleton className="h-11 w-28 rounded-full" />
            </div>
          </div>
          <div className="hidden lg:block">
            <Skeleton className="aspect-square max-w-md mx-auto rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

export function CategorySkeleton() {
  return (
    <div className="py-6">
      <div className="container">
        <Skeleton className="h-6 w-24 mb-4" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-20 rounded-2xl shrink-0" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function PromoSkeleton() {
  return (
    <div className="py-6">
      <div className="container">
        <Skeleton className="h-6 w-32 mb-4" />
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="min-w-[280px] sm:min-w-[320px] aspect-[16/9] rounded-2xl shrink-0" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function CartItemSkeleton() {
  return (
    <div className="flex gap-4 p-4 border rounded-xl">
      <Skeleton className="h-20 w-20 rounded-lg shrink-0" />
      <div className="flex-1">
        <Skeleton className="h-5 w-3/4 mb-2" />
        <Skeleton className="h-4 w-1/2 mb-3" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-5 w-16" />
        </div>
      </div>
    </div>
  )
}

export function OrderCardSkeleton() {
  return (
    <div className="border rounded-xl p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <Skeleton className="h-5 w-32 mb-1" />
          <Skeleton className="h-4 w-24" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
      <div className="flex gap-3 mb-3">
        <Skeleton className="h-16 w-16 rounded-lg" />
        <Skeleton className="h-16 w-16 rounded-lg" />
      </div>
      <Skeleton className="h-4 w-full" />
    </div>
  )
}
