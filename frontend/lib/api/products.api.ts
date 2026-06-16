import { api, buildQuery } from './client'
import type { Product, Category, Topping, Promo } from '@/lib/types/models'

export type ProductQuery = {
  search?: string
  category?: string
  sort?: 'popular' | 'price-low' | 'price-high' | 'rating'
}

export const productsApi = {
  list: (q: ProductQuery = {}) => api.get<Product[]>(`/catalog/products${buildQuery(q)}`),
  detail: (idOrSlug: string) => api.get<Product>(`/catalog/products/${idOrSlug}`),
  categories: () => api.get<Category[]>('/catalog/categories'),
  toppings: () => api.get<Topping[]>('/catalog/toppings'),
  promos: () => api.get<Promo[]>('/catalog/promos'),
}
