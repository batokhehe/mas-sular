import { type ReactNode } from 'react'
import { RequireAuth } from '@/components/auth/require-auth'

// Protects /orders — customers must be signed in.
export default function OrdersLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>
}
