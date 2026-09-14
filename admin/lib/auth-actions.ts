'use client';

import { api, notifyAuthChanged } from './api';
import { writeStoredPermissions } from './permissions';

/**
 * Login response. The access token is NOT part of it: the API sets it as the
 * httpOnly ms_admin_access cookie, which page scripts cannot read (H4).
 */
export type AdminLoginResponse = {
  user: {
    id: string;
    name: string;
    email: string;
    role?: {
      id: string;
      name: string;
    } | null;
  };
  permissions?: string[];
  expiresAt?: string;
};

export async function loginAdmin(email: string, password: string) {
  const data = await api<AdminLoginResponse>('/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  writeStoredPermissions(data.permissions ?? []);
  notifyAuthChanged();
  return data;
}
