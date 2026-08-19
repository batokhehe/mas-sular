'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck, WifiOff } from 'lucide-react';
import Swal from 'sweetalert2';
import {
  fetchBellNotifications, fetchUnreadCount, markAllNotificationsRead, markNotificationRead,
  bellStreamUrl, BellNotification,
} from '@/lib/notifications';
import { BELL_FILTERS, PRIORITY_DOT, relativeTime, groupByDay, reduceUnread, badgeLabel } from '@/lib/system/bell-view';
import { trailingDebounce } from '@/lib/debounce';
import { runWithFeedback } from '@/lib/admin-alert';

const RECONNECT_DELAY_MS = 5000; // manual retry after EventSource error
const TOAST_DURATION_MS = 4000;
const LIST_INVALIDATE_DEBOUNCE_MS = 1500; // coalesce refetches during event storms

const toast = Swal.mixin({
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  timer: TOAST_DURATION_MS,
  timerProgressBar: true,
});

type ConnectionState = 'connecting' | 'live' | 'offline';

/**
 * Notification bell: badge + drawer + realtime SSE (auto-reconnect, heartbeat is
 * server-side). Self-contained so it drops into the existing Topbar. The counter
 * stays in sync across tabs because EVERY tab holds its own SSE connection and
 * receives counter/read events.
 */
export function NotificationBell() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filterKey, setFilterKey] = useState('all');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [unread, setUnread] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Initial badge from the API; afterwards the SSE reducer keeps it live.
  const count = useQuery({ queryKey: ['bell-count'], queryFn: fetchUnreadCount, retry: false, staleTime: 60_000 });
  useEffect(() => {
    if (count.data) setUnread(count.data.count);
  }, [count.data]);

  // ----- SSE with automatic reconnect + offline awareness -----
  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    // Event storms must not trigger one refetch per event.
    const invalidateList = trailingDebounce(() => qc.invalidateQueries({ queryKey: ['bell-list'] }), LIST_INVALIDATE_DEBOUNCE_MS);

    const connect = () => {
      const url = bellStreamUrl();
      if (!url || stopped) return;
      source = new EventSource(url);
      source.onopen = () => {
        setConnection('live');
        // Resync the badge after a reconnect — events during the gap were missed.
        void qc.invalidateQueries({ queryKey: ['bell-count'] });
      };
      source.onerror = () => {
        setConnection('offline');
        source?.close();
        if (!stopped) retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      source.addEventListener('notification.created', (e) => {
        setUnread((c) => reduceUnread(c, { type: 'notification.created' }));
        invalidateList();
        try {
          const draft = JSON.parse((e as MessageEvent).data) as { title?: string; message?: string };
          void toast.fire({ icon: 'info', title: draft.title ?? 'Notification', text: draft.message ?? '' });
        } catch {
          // toast is best-effort
        }
      });
      source.addEventListener('notification.read', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { id: string | 'all' };
          setUnread((c) => reduceUnread(c, { type: 'notification.read', readId: data.id }));
        } catch {
          // ignore malformed
        }
        invalidateList();
      });
    };

    const onOnline = () => connect();
    const onOffline = () => setConnection('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      invalidateList.cancel();
      source?.close();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [qc]);

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (open && containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const filter = BELL_FILTERS.find((f) => f.key === filterKey) ?? BELL_FILTERS[0];
  const list = useQuery({
    queryKey: ['bell-list', filterKey],
    queryFn: () => fetchBellNotifications({ limit: 15, unread: filter.unread, category: filter.category }),
    enabled: open,
    retry: false,
  });

  const onItemClick = useCallback(
    async (item: BellNotification) => {
      setOpen(false);
      if (!item.isRead) {
        // No optimistic decrement here: the server's notification.read broadcast
        // reaches this tab too, so a local decrement would double-count. The
        // count refetch covers the SSE-disconnected case.
        markNotificationRead(item.id)
          .then(() => qc.invalidateQueries({ queryKey: ['bell-count'] }))
          .catch(() => undefined);
      }
      if (item.url) router.push(item.url);
    },
    [router, qc],
  );

  const markAll = () =>
    runWithFeedback({
      loading: 'Marking all as read…',
      success: 'All notifications marked as read',
      action: async () => {
        await markAllNotificationsRead();
        setUnread(0); // idempotent with the SSE 'all' echo
        qc.invalidateQueries({ queryKey: ['bell-list'] });
      },
    });

  const badge = badgeLabel(unread);
  const groups = list.data ? groupByDay(list.data.items) : [];

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        className="relative flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50"
      >
        <Bell className="h-4 w-4" />
        {badge ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[380px] rounded-2xl border border-gray-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
            <p className="font-semibold text-gray-900">Notifications</p>
            <span className="flex items-center gap-3">
              {connection !== 'live' ? (
                <span className="flex items-center gap-1 text-xs text-amber-600"><WifiOff className="h-3 w-3" /> {connection === 'offline' ? 'reconnecting…' : 'connecting…'}</span>
              ) : null}
              <button onClick={markAll} title="Mark all read" className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff] hover:underline">
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            </span>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-gray-100 px-3 py-2">
            {BELL_FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilterKey(f.key)} className={`rounded-lg px-2 py-1 text-xs font-medium ${filterKey === f.key ? 'bg-[#465fff]/10 text-[#465fff]' : 'text-gray-500 hover:text-gray-800'}`}>
                {f.label}
              </button>
            ))}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {list.isLoading ? (
              <div className="space-y-2 p-4">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-12 w-full animate-pulse rounded-lg bg-gray-100" />)}</div>
            ) : list.isError ? (
              <p className="p-6 text-center text-sm text-red-600">Unable to load notifications.</p>
            ) : groups.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">You&apos;re all caught up.</p>
            ) : (
              groups.map((g) => (
                <div key={g.label}>
                  <p className="bg-gray-50 px-4 py-1.5 text-xs font-semibold uppercase text-gray-400">{g.label}</p>
                  {g.items.map((item) => (
                    <button key={item.id} onClick={() => void onItemClick(item)} className={`flex w-full gap-3 border-b border-gray-50 px-4 py-3 text-left last:border-0 hover:bg-gray-50 ${item.isRead ? 'opacity-60' : ''}`}>
                      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[item.priority]}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-gray-900">{item.title}</span>
                        <span className="block truncate text-xs text-gray-500">{item.message}</span>
                        <span className="mt-0.5 block text-[11px] text-gray-400">{relativeTime(item.createdAt)}</span>
                      </span>
                      {!item.isRead ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#465fff]" /> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-gray-100 p-2 text-center">
            <button onClick={() => { setOpen(false); router.push('/notifications'); }} className="text-sm font-medium text-[#465fff] hover:underline">
              View all notifications
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
