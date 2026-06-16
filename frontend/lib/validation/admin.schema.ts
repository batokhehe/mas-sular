import { z } from 'zod'

export const adminLoginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
})
export type AdminLoginForm = z.infer<typeof adminLoginSchema>

export const paymentDecisionSchema = z.object({
  note: z.string().optional(),
})
export type PaymentDecisionForm = z.infer<typeof paymentDecisionSchema>
