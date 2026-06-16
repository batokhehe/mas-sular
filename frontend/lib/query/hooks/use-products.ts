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
