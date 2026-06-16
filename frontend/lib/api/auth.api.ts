import { api } from './client'
import type { AuthTokens, AdminSession, User } from '@/lib/types/models'

export const authApi = {
  googleLogin: (idToken: string) =>
    api.post<AuthTokens & { user: User }>('/auth/google', { idToken }),
  refresh: (refreshToken: string) => api.post<AuthTokens>('/auth/refresh', { refreshToken }),
  me: () => api.get<User>('/users/me', 'customer'),

  adminLogin: (email: string, password: string) =>
    api.post<{ accessToken: string; admin: AdminSession }>('/admin/auth/login', { email, password }),
  adminMe: () => api.get<AdminSession>('/admin/auth/me', 'admin'),
  adminLogout: () => api.post<{ success: boolean }>('/admin/auth/logout', undefined, 'admin'),
}
