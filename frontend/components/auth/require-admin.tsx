'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { usePermissions } from '@/lib/auth/use-permissions'
import { hasAdminSession } from '@/lib/auth/tokens'

/**
 * Guards the admin panel. No admin cookie → redirect to /admin/login. Cookie
 * present but /admin/auth/me fails (expired/invalid) → also redirect. While the
 * session resolves, shows a loader.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const router = useRouter()
  const { admin, isLoading } = usePermissions()
  const hasSession = hasAdminSession()

  useEffect(() => {
    if (!hasSession) {
      router.replace('/admin/login')
      return
    }
    if (!isLoading && !admin) router.replace('/admin/login')
  }, [hasSession, isLoading, admin, router])

  if (!hasSession) return null
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!admin) return null
  return <>{children}</>
}
