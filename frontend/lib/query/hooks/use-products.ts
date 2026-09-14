'use client'

import { useQuery } from '@tanstack/react-query'
import { productsApi, type ProductQuery } from '@/lib/api/products.api'
import { qk } from '@/lib/query/keys'

export function useProducts(query: ProductQuery = {}) {
  return useQuery({
    queryKey: qk.catalog.products(query),
    queryFn: () => productsApi.list(query),
  })
}

/**
 * Toppings a customer can add to a product. GET /catalog/toppings returns only
 * active, non-deleted toppings (the backend filters); the order endpoint re-checks
 * and reprices them, so this list is for display and selection only.
 */
export function useToppings() {
  return useQuery({
    queryKey: qk.catalog.toppings,
    queryFn: () => productsApi.toppings(),
  })
}
