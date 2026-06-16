import { type ReactNode } from 'react'
import { RequireAuth } from '@/components/auth/require-auth'

// Protects /checkout and /checkout/success — customers must be signed in.
export default function CheckoutLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>
}
