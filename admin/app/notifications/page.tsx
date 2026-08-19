'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, Loader2, RefreshCw } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchBellNotifications, markAllNotificationsRead, markNotificationRead, BellNotification } from '@/lib/notifications';
import { BELL_FILTERS, PRIORITY_DOT, relativeTime, groupByDay } from '@/lib/system/bell-view';
import { runWithFeedback } from '@/lib/admin-alert';

export default function NotificationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [filterKey, setFilterKey] = useState('all');
  const filter = BELL_FILTERS.find((f) => f.key === filterKey) ?? BELL_FILTERS[0];

  // Cursor-based infinite list — nextCursor comes straight from the API page.
  const query = useInfiniteQuery({
    queryKey: ['notifications-page', filterKey],
    queryFn: ({ pageParam }) =>
      fetchBellNotifications({ cursor: pageParam || undefined, limit: 20, unread: filter.unread, category: filter.category }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const groups = groupByDay(items);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['notifications-page'] });
    qc.invalidateQueries({ queryKey: ['bell-count'] });
    qc.invalidateQueries({ queryKey: ['bell-list'] });
  };

  const onItemClick = (item: BellNotification) => {
    if (!item.isRead) {
      markNotificationRead(item.id)
        .then(invalidate)
        .catch(() => undefined);
    }
    if (item.url) router.push(item.url);
  };

  const markAll = () =>
    runWithFeedback({
      loading: 'Marking all as read…',
      success: 'All notifications marked as read',
      action: async () => {
        await markAllNotificationsRead();
        invalidate();
      },
    });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.notifications}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Notifications</h1>
          <p className="mt-1 text-sm text-gray-500">Everything the platform wants you to know — orders, payments, inventory, and system events.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button className="border border-gray-200 bg-white text-gray-700 hover:bg-gray-50" onClick={() => query.refetch()} disabled={query.isRefetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${query.isRefetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button onClick={markAll}>
            <CheckCheck className="mr-2 h-4 w-4" /> Mark all read
          </Button>
        </div>
      </div>

      <Card className="p-0">
        <div className="flex flex-wrap gap-1 border-b border-gray-100 px-4 py-3">
          {BELL_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterKey(f.key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${filterKey === f.key ? 'bg-[#465fff]/10 text-[#465fff]' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {query.isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-14 w-full animate-pulse rounded-xl bg-gray-100" />
            ))}
          </div>
        ) : query.isError ? (
          <p className="p-10 text-center text-sm text-red-600">Unable to load notifications. {(query.error as Error)?.message}</p>
        ) : groups.length === 0 ? (
          <p className="p-12 text-center text-sm text-gray-500">You&apos;re all caught up — nothing here.</p>
        ) : (
          groups.map((g) => (
            <div key={g.label}>
              <p className="bg-gray-50 px-6 py-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{g.label}</p>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onItemClick(item)}
                  className={`flex w-full gap-4 border-b border-gray-50 px-6 py-4 text-left last:border-0 hover:bg-gray-50 ${item.isRead ? 'opacity-60' : ''}`}
                >
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${PRIORITY_DOT[item.priority]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-gray-900">{item.title}</span>
                      <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-500">{item.category}</span>
                    </span>
                    <span className="mt-0.5 block text-sm text-gray-600">{item.message}</span>
                    <span className="mt-1 block text-xs text-gray-400">{relativeTime(item.createdAt)}</span>
                  </span>
                  {!item.isRead ? <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#465fff]" /> : null}
                </button>
              ))}
            </div>
          ))
        )}

        {query.hasNextPage ? (
          <div className="border-t border-gray-100 p-4 text-center">
            <Button className="border border-gray-200 bg-white text-gray-700 hover:bg-gray-50" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
              {query.isFetchingNextPage ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </AdminShell>
  );
}
