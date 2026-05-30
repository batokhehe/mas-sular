'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api, ApiError, setAuthToken } from './api';

export type AdminProfile = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
};

export async function loginAdmin(email: string, password: string) {
  const data = await api<{ accessToken: string }>('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  setAuthToken(data.accessToken);
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
      router.replace('/login');
    }
  }, [profileQuery.error, router]);

  return profileQuery;
}

export function useAdminLogout() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useMutation<void, ApiError>({
    mutationFn: logoutAdmin,
    onSuccess() {
      setAuthToken(null);
      queryClient.clear();
      router.replace('/login');
    },
  });
}

export function isAdminAuthenticated() {
  return Boolean(typeof window !== 'undefined' && window.localStorage.getItem('mas-sular-admin-token'));
}
