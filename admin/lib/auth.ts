'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { ADMIN_AUTH_TOKEN_EVENT, api, ApiError, getAuthToken, setAuthToken } from './api';
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
    setAuthToken(null);
    clearStoredPermissions();
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
      setAuthToken(null);
      clearStoredPermissions();
      queryClient.clear();
      router.replace('/login');
    },
  });
}

export function isAdminAuthenticated() {
  return Boolean(getAuthToken());
}
