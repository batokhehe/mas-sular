import { api, apiBaseUrl, getAuthToken } from './api';

/** Admin bell / notification platform API client. */

export type BellCategory = 'ORDER' | 'PAYMENT' | 'INVENTORY' | 'SYSTEM' | 'SECURITY' | 'AUDIT';
export type BellPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type BellNotification = {
  id: string;
  eventType: string;
  category: BellCategory;
  priority: BellPriority;
  title: string;
  message: string;
  url: string | null;
  icon: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
};

export type BellPage = { items: BellNotification[]; nextCursor: string | null };

export function fetchBellNotifications(params: { cursor?: string; limit?: number; unread?: boolean; category?: string } = {}) {
  const q = new URLSearchParams();
  if (params.cursor) q.set('cursor', params.cursor);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.unread) q.set('unread', 'true');
  if (params.category) q.set('category', params.category);
  const query = q.toString();
  return api<BellPage>(`/admin/notifications${query ? `?${query}` : ''}`);
}

export function fetchUnreadCount() {
  return api<{ count: number }>('/admin/notifications/unread-count');
}

export function markNotificationRead(id: string) {
  return api<{ read: boolean }>(`/admin/notifications/${id}/read`, { method: 'PATCH' });
}

export function markAllNotificationsRead() {
  return api<{ read: number }>('/admin/notifications/read-all', { method: 'PATCH' });
}

export function registerPushToken(input: { token: string; browser?: string; platform?: string; device?: string }) {
  return api('/admin/push/register', { method: 'POST', body: JSON.stringify(input) });
}

export function unregisterPushToken(token: string) {
  return api(`/admin/push/register/${encodeURIComponent(token)}`, { method: 'DELETE' });
}

/** SSE endpoint URL (EventSource cannot send headers → JWT rides as ?token=). */
export function bellStreamUrl(): string | null {
  const token = getAuthToken();
  if (!token) return null;
  return `${apiBaseUrl()}/admin/notifications/stream?token=${encodeURIComponent(token)}`;
}
