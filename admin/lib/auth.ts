'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ADMIN_AUTH_TOKEN_EVENT, api, ApiError, clearAdminSessionMarker, hasAdminSessionMarker, notifyAuthChanged } from './api';
import {
  ADMIN_PERMISSIONS_EVENT,
  clearStoredPermissions,
  readStoredPermissions,
  writeStoredPermissions,
} from './permissions';
export { loginAdmin, type AdminLoginResponse } from './auth-actions';

export type AdminProfile = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role?: string | null;
  permissions?: string[];
};

export async function fetchAdminProfile() {
  return api<AdminProfile>('/admin/auth/me');
}

export async function logoutAdmin() {
  try {
    await api('/admin/auth/logout', {
      method: 'POST',
    });
  } finally {
    // The API cleared the httpOnly cookie and revoked the session; drop local UI state.
    clearAdminSessionMarker();
    clearStoredPermissions();
    notifyAuthChanged();
  }
}

export function useAdminProfile(options?: { enabled?: boolean }) {
  const queryClient = useQueryClient();
  const profileQuery = useQuery<AdminProfile, ApiError>({
    queryKey: ['admin-profile'],
    queryFn: fetchAdminProfile,
    retry: false,
    staleTime: 1000 * 60 * 5,
    enabled: options?.enabled ?? true,
  });

  useEffect(() => {
    if (profileQuery.error?.status === 401) {
      queryClient.removeQueries({ queryKey: ['admin-profile'] });
    }
  }, [profileQuery.error, queryClient]);

  useEffect(() => {
    if (profileQuery.data?.permissions) {
      writeStoredPermissions(profileQuery.data.permissions);
    }
  }, [profileQuery.data?.permissions]);

  return profileQuery;
}

export function useAdminAuthStatus() {
  const [isInitialized, setIsInitialized] = useState(false);
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    const syncAuthToken = () => {
      setHasToken(isAdminAuthenticated());
    };

    syncAuthToken();
    setIsInitialized(true);

    window.addEventListener(ADMIN_AUTH_TOKEN_EVENT, syncAuthToken);
    window.addEventListener('storage', syncAuthToken);

    return () => {
      window.removeEventListener(ADMIN_AUTH_TOKEN_EVENT, syncAuthToken);
      window.removeEventListener('storage', syncAuthToken);
    };
  }, []);

  return { isInitialized, hasToken };
}

export function useAdminPermissions() {
  const [permissions, setPermissions] = useState<string[]>(() => readStoredPermissions());

  useEffect(() => {
    const syncPermissions = () => {
      setPermissions(readStoredPermissions());
    };

    window.addEventListener(ADMIN_PERMISSIONS_EVENT, syncPermissions);
    syncPermissions();

    return () => {
      window.removeEventListener(ADMIN_PERMISSIONS_EVENT, syncPermissions);
    };
  }, []);

  return permissions;
}

export function useAdminLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation<void, ApiError>({
    mutationFn: logoutAdmin,
    onSettled() {
      clearAdminSessionMarker();
      clearStoredPermissions();
      queryClient.clear();
      router.replace('/login');
    },
  });
}

/** Session presence only (the marker cookie carries no token); /admin/auth/me is authoritative. */
export function isAdminAuthenticated() {
  return hasAdminSessionMarker();
}
