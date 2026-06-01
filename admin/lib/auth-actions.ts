'use client';

import { api, setAuthToken } from './api';
import { writeStoredPermissions } from './permissions';

export type AdminLoginResponse = {
  accessToken: string;
  refreshToken?: string;
  user: {
    id: string;
    name: string;
    email: string;
    isActive: boolean;
    permissions?: string[];
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
