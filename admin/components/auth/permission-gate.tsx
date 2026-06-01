'use client';

import { ReactNode } from 'react';
import { useAdminPermissions } from '@/lib/auth';
import { hasAllPermissions, hasAnyPermission } from '@/lib/permissions';

type PermissionGateProps = {
  permissions: readonly string[];
  children: ReactNode;
  fallback?: ReactNode;
  mode?: 'all' | 'any';
};

export function PermissionGate({
  permissions,
  children,
  fallback = null,
  mode = 'all',
}: PermissionGateProps) {
  const adminPermissions = useAdminPermissions();
  const allowed =
    mode === 'any'
      ? hasAnyPermission(adminPermissions, permissions)
      : hasAllPermissions(adminPermissions, permissions);

  return allowed ? <>{children}</> : <>{fallback}</>;
}
