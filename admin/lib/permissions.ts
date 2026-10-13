export type Permission = string;

export const ADMIN_PERMISSIONS_STORAGE_KEY = 'mas-sular-admin-permissions';
export const ADMIN_PERMISSIONS_EVENT = 'mas-sular-admin-permissions-change';
export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export function buildPermission(subject: string, action: string): Permission {
  return `${subject}.${action}`;
}

/** Canonical system role only - a role merely NAMED "Super Admin" is not super admin (H1). */
export function isSuperAdminRole(role?: string | null) {
  return role === SUPER_ADMIN_ROLE;
}

export function hasPermission(permissions: readonly string[] | null | undefined, permission: string) {
  if (!permissions?.length) {
    return false;
  }

  // Exact names only, mirroring the API (no legacy `orders.view`-style aliases).
  return permissions.includes(permission);
}

export function hasAllPermissions(
  permissions: readonly string[] | null | undefined,
  requiredPermissions: readonly string[],
) {
  if (!requiredPermissions.length) {
    return true;
  }

  if (!permissions?.length) {
    return false;
  }

  return requiredPermissions.every((permission) => hasPermission(permissions, permission));
}

export function hasAnyPermission(
  permissions: readonly string[] | null | undefined,
  requiredPermissions: readonly string[],
) {
  if (!requiredPermissions.length) {
    return true;
  }

  if (!permissions?.length) {
    return false;
  }

  return requiredPermissions.some((permission) => hasPermission(permissions, permission));
}

export function readStoredPermissions() {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(ADMIN_PERMISSIONS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((permission): permission is string => typeof permission === 'string')
      : [];
  } catch {
    return [];
  }
}

function notifyPermissionsChanged() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event(ADMIN_PERMISSIONS_EVENT));
}

export function writeStoredPermissions(permissions: readonly string[]) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(ADMIN_PERMISSIONS_STORAGE_KEY, JSON.stringify(permissions));
  notifyPermissionsChanged();
}

export function clearStoredPermissions() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(ADMIN_PERMISSIONS_STORAGE_KEY);
  notifyPermissionsChanged();
}
