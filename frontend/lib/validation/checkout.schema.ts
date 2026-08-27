import { z } from 'zod'

export const checkoutItemSchema = z.object({
  product_id: z.string().min(1),
  qty: z.number().int().min(1),
  topping_ids: z.array(z.string()).optional(),
  spicyLevel: z.number().int().min(0).max(5).optional(),
  notes: z.string().optional(),
})

export const createOrderSchema = z.object({
  address_id: z.string().min(1, 'Select a delivery address'),
  courier: z.enum(['paxel', 'jne']),
  // COD removed (Phase 4A): the storefront can no longer submit it.
  payment_method: z.enum(['BANK_TRANSFER', 'QRIS', 'GATEWAY']).optional(),
  voucher_code: z.string().optional(),
  items: z.array(checkoutItemSchema).min(1, 'Your cart is empty'),
})

export type CreateOrderForm = z.infer<typeof createOrderSchema>
