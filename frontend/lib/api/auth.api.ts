import { api } from './client'
import type { AuthTokens, AdminSession, User } from '@/lib/types/models'
import type { AdminPermission } from '@/lib/types/enums'

// Customer Google login returns the user plus a NESTED `tokens` object:
//   { user: User, tokens: { accessToken, refreshToken } }
export interface GoogleLoginResponse {
  user: User
  tokens: AuthTokens
}

// Admin login returns the admin user + permissions. The access token is set by the
// API as an httpOnly cookie and is deliberately NOT in the body (H4).
export interface AdminLoginResponse {
  user: { id: string; name: string; email: string }
  permissions: AdminPermission[]
  expiresAt?: string
}

export const authApi = {
  googleLogin: (idToken: string) => api.post<GoogleLoginResponse>('/auth/google', { idToken }),
  refresh: (refreshToken: string) => api.post<AuthTokens>('/auth/refresh', { refreshToken }),
  me: () => api.get<User>('/users/me', 'customer'),
  // Phase 13B.5: terminate the server session. Cookie-only (audience 'customer' →
  // no Authorization header; credentials:'include' sends ms_refresh). Backend
  // revokes the refresh token and clears ms_access/ms_refresh/ms_session.
  logout: () => api.post<{ success: boolean }>('/auth/logout', undefined, 'customer'),

  adminLogin: (email: string, password: string) =>
    api.post<AdminLoginResponse>('/admin/auth/login', { email, password }),
  adminMe: () => api.get<AdminSession>('/admin/auth/me', 'admin'),
  adminLogout: () => api.post<{ success: boolean }>('/admin/auth/logout', undefined, 'admin'),
}
