import type { BellCategory, BellNotification, BellPriority } from '@/lib/notifications';

/** Pure view helpers for the notification bell/drawer (unit-testable sans React). */

export const BELL_FILTERS: Array<{ key: string; label: string; category?: BellCategory; unread?: boolean }> = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread', unread: true },
  { key: 'orders', label: 'Orders', category: 'ORDER' },
  { key: 'payments', label: 'Payments', category: 'PAYMENT' },
  { key: 'inventory', label: 'Inventory', category: 'INVENTORY' },
  { key: 'system', label: 'System', category: 'SYSTEM' },
  { key: 'security', label: 'Security', category: 'SECURITY' },
  { key: 'audit', label: 'Audit', category: 'AUDIT' },
];

export const PRIORITY_DOT: Record<BellPriority, string> = {
  CRITICAL: 'bg-red-500',
  HIGH: 'bg-orange-400',
  MEDIUM: 'bg-blue-400',
  LOW: 'bg-gray-300',
};

/** "just now", "5m ago", "3h ago", "2d ago", else a local date. */
export function relativeTime(iso: string, now = new Date()): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('id-ID');
}

export type DayGroup = { label: 'Today' | 'Yesterday' | 'Older'; items: BellNotification[] };

/** Group by Today / Yesterday / Older, preserving newest-first order. */
export function groupByDay(items: BellNotification[], now = new Date()): DayGroup[] {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

  const groups: DayGroup[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const item of items) {
    const t = new Date(item.createdAt).getTime();
    if (t >= todayStart.getTime()) groups[0].items.push(item);
    else if (t >= yesterdayStart.getTime()) groups[1].items.push(item);
    else groups[2].items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Badge reducer for SSE events — pure so multi-tab sync logic is testable. */
export function reduceUnread(current: number, event: { type: string; readId?: string | 'all' }): number {
  if (event.type === 'notification.created') return current + 1;
  if (event.type === 'notification.read') return event.readId === 'all' ? 0 : Math.max(0, current - 1);
  return current;
}

/** Badge display: 0 → hidden, 1..99 verbatim, 100+ → "99+". */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
