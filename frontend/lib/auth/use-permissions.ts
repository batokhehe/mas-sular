'use client'

import { useQuery } from '@tanstack/react-query'
import { authApi } from '@/lib/api/auth.api'
import { qk } from '@/lib/query/keys'
import { hasAdminSession } from './tokens'
import type { AdminPermission } from '@/lib/types/enums'

export function usePermissions() {
  const { data, isLoading } = useQuery({
    queryKey: qk.admin.me,
    queryFn: authApi.adminMe,
    enabled: hasAdminSession(),
    retry: false,
  })

  const granted = new Set<string>(data?.permissions ?? [])

  return {
    admin: data ?? null,
    isLoading,
    permissions: data?.permissions ?? [],
    can: (permission: AdminPermission) => granted.has(permission),
    canAny: (...permissions: AdminPermission[]) => permissions.some((p) => granted.has(p)),
  }
}
