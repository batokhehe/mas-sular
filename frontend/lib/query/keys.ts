import type { ProductQuery } from '@/lib/api/products.api'

// Centralized query-key factory — every hook derives its key from here so
// invalidation stays consistent.
export const qk = {
  me: ['me'] as const,
  addresses: ['addresses'] as const,

  catalog: {
    products: (q: ProductQuery) => ['catalog', 'products', q] as const,
    product: (idOrSlug: string) => ['catalog', 'product', idOrSlug] as const,
    categories: ['catalog', 'categories'] as const,
    toppings: ['catalog', 'toppings'] as const,
    promos: ['catalog', 'promos'] as const,
  },

  orders: (userId: string, status?: string) => ['orders', userId, status ?? 'all'] as const,
  uploadPage: (token: string) => ['payment-upload', token] as const,

  admin: {
    me: ['admin', 'me'] as const,
    dashboard: ['admin', 'dashboard'] as const,
    payments: (status?: string) => ['admin', 'payments', status ?? 'pending'] as const,
    orders: (q: unknown) => ['admin', 'orders', q] as const,
    order: (id: string) => ['admin', 'order', id] as const,
    shipments: (status?: string) => ['admin', 'shipments', status ?? 'all'] as const,
  },
}
