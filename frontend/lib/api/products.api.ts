import { api, buildQuery } from './client'
import type { Product, Category, Topping, Promo } from '@/lib/types/models'

export type ProductQuery = {
  search?: string
  category?: string
  sort?: 'popular' | 'price-low' | 'price-high' | 'rating'
  /** P2 #10: server-side filter on Product.isPromoSpecial (same visibility rules). */
  promoSpecial?: boolean
  /** P2 #11: server-side filter on Product.isTrialPack (same visibility rules). */
  trialPack?: boolean
}

export const productsApi = {
  list: (q: ProductQuery = {}) => api.get<Product[]>(`/catalog/products${buildQuery(q)}`),
  detail: (idOrSlug: string) => api.get<Product>(`/catalog/products/${idOrSlug}`),
  categories: () => api.get<Category[]>('/catalog/categories'),
  toppings: () => api.get<Topping[]>('/catalog/toppings'),
  promos: () => api.get<Promo[]>('/catalog/promos'),
}
