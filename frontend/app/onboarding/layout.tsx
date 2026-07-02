import { type ReactNode } from 'react'
import { RequireAuth } from '@/components/auth/require-auth'

// Onboarding keeps its own standalone header (no StorefrontShell); only the
// real auth guard is applied.
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <RequireAuth>{children}</RequireAuth>
}
