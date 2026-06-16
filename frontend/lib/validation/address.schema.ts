import { z } from 'zod'

export const addressSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  recipientName: z.string().min(1, 'Recipient name is required'),
  phone: z.string().min(6, 'Enter a valid phone number'),
  fullAddress: z.string().min(1, 'Address is required'),
  latitude: z.coerce.number(),
  longitude: z.coerce.number(),
  isDefault: z.boolean().optional(),
  notes: z.string().optional(),
})

export type AddressForm = z.infer<typeof addressSchema>
