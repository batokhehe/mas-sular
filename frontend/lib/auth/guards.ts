'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { hasAdminSession, hasCustomerSession } from './tokens'

/** Client-side guard: redirect to login when there is no customer session. */
export function useRequireCustomer(redirectTo = '/login'): void {
  const router = useRouter()
  useEffect(() => {
    if (!hasCustomerSession()) router.replace(redirectTo)
  }, [router, redirectTo])
}

/** Client-side guard: redirect to the admin login when there is no admin session. */
export function useRequireAdmin(redirectTo = '/admin/login'): void {
  const router = useRouter()
  useEffect(() => {
    if (!hasAdminSession()) router.replace(redirectTo)
  }, [router, redirectTo])
}
