'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, ApiError, setAuthToken } from './api';
import {
  ADMIN_PERMISSIONS_EVENT,
  clearStoredPermissions,
  readStoredPermissions,
  writeStoredPermissions,
} from './permissions';

export type AdminProfile = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
};

export type AdminLoginResponse = {
  accessToken: string;
  refreshToken?: string;
  user: AdminProfile & {
    role?: {
      id: string;
      name: string;
    } | null;
  };
  permissions?: string[];
};

export async function loginAdmin(email: string, password: string) {
  const data = await api<AdminLoginResponse>('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  setAuthToken(data.accessToken);
  writeStoredPermissions(data.permissions ?? []);
  return data;
}

export async function fetchAdminProfile() {
  return api<AdminProfile>('/admin/auth/me');
}

export async function logoutAdmin() {
  await api('/admin/auth/logout', {
    method: 'POST',
  });
  setAuthToken(null);
  clearStoredPermissions();
}

export function useAdminProfile() {
  const router = useRouter();
  const profileQuery = useQuery<AdminProfile, ApiError>({
    queryKey: ['admin-profile'],
    queryFn: fetchAdminProfile,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  useEffect(() => {
    if (profileQuery.error?.status === 401) {
      setAuthToken(null);
      clearStoredPermissions();
      router.replace('/login');
    }
  }, [profileQuery.error, router]);

  return profileQuery;
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
    onSuccess() {
      setAuthToken(null);
      clearStoredPermissions();
      queryClient.clear();
      router.replace('/login');
    },
  });
}

export function isAdminAuthenticated() {
  return Boolean(typeof window !== 'undefined' && window.localStorage.getItem('mas-sular-admin-token'));
}
