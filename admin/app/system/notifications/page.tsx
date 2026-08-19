'use client';

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, FileJson, FilterX, RefreshCw, RotateCcw, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { TrendChart, DonutChart, BarChart } from '@/components/dashboard/charts';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  bulkResendNotifications, fetchNotificationCenter, resendNotification,
  NotificationCenterFilters, NotificationChannel, NotificationRow, NotificationSendStatus,
} from '@/lib/admin';
import {
  CHANNELS, SEND_STATUSES, NOTIF_STATUS_BADGE, CHANNEL_BADGE, deliveryLabel, canResend, trendSeries,
  PROVIDERS, BULK_RETRY_LIMIT, FILTER_STORAGE_KEY, retryableIds, sanitizeFilters, updatedAgoLabel,
} from '@/lib/system/notification-view';
import { ADMIN_LOADING_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

// Drawer is lazy-loaded: its code is only fetched when an admin opens a row.
const NotificationDrawer = dynamic(() => import('./notification-drawer'), { ssr: false });

const STATUS_COLORS: Record<string, string> = { SENT: '#22c55e', PENDING: '#f59e0b', FAILED: '#ef4444' };
const CHANNEL_COLORS: Record<string, string> = { WHATSAPP: '#22c55e', EMAIL: '#3b82f6', PUSH: '#a855f7', SMS: '#f59e0b', IN_APP: '#64748b' };
const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const rp = (n: number) => n.toLocaleString('id-ID');

/** datetime-local input value from a persisted ISO string. */
function toLocalInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NotificationCenterPage() {
  const qc = useQueryClient();
  const [filters, setFilters] = useState<NotificationCenterFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Multi-select keeps the full row (not just the id) so Export works across pages.
  const [selectedRows, setSelectedRows] = useState<Map<string, NotificationRow>>(new Map());
  // Filters restore from localStorage after mount (avoids SSR hydration mismatch);
  // the query waits for that so the first fetch already carries them.
  const [ready, setReady] = useState(false);
  const [filterFormKey, setFilterFormKey] = useState(0); // bump to remount uncontrolled inputs on Reset
  const [nowTick, setNowTick] = useState(() => Date.now());
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (raw) setFilters(sanitizeFilters(JSON.parse(raw)));
    } catch {
      // corrupt/unavailable storage → start clean
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // best-effort persistence
    }
  }, [filters, ready]);

  // 1s tick drives the "Updated Xs ago" label only.
  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);

  // MF-1: a pending filter-debounce must not fire (setState) after unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const patch = (p: Partial<NotificationCenterFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };
  // Text/number inputs debounce so typing doesn't fire a request per keystroke.
  const patchDebounced = (p: Partial<NotificationCenterFilters>) => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => patch(p), 350);
  };
  const resetFilters = () => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    setFilters({});
    setPage(1);
    setFilterFormKey((k) => k + 1);
    try {
      window.localStorage.removeItem(FILTER_STORAGE_KEY);
    } catch {
      // best-effort
    }
  };

  const query = useQuery({
    queryKey: ['notification-center', filters, page, limit],
    queryFn: () => fetchNotificationCenter({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 30_000, // auto refresh
    retry: false,
    enabled: ready,
  });
  const data = query.data;
  const o = data?.overview;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notification-center'] });
    if (selectedId) qc.invalidateQueries({ queryKey: ['notification-detail', selectedId] });
  };
  const resendM = useMutation({ mutationFn: resendNotification, onSuccess: refresh });
  const resend = (id: string) =>
    runWithFeedback({ loading: ADMIN_LOADING_MESSAGES.update, success: 'Notification queued for resend', action: () => resendM.mutateAsync(id) });

  // ---- Bulk actions ----
  const selectedList = useMemo(() => Array.from(selectedRows.values()), [selectedRows]);
  const failedIds = useMemo(
    () => retryableIds(selectedList, new Set(selectedRows.keys())),
    [selectedList, selectedRows],
  );
  const bulkRetryM = useMutation({
    mutationFn: bulkResendNotifications,
    onSuccess: () => {
      setSelectedRows(new Map());
      refresh();
    },
  });
  const bulkRetry = () =>
    runWithFeedback({
      loading: ADMIN_LOADING_MESSAGES.update,
      success: `${failedIds.length} failed notification(s) queued for resend`,
      action: () => bulkRetryM.mutateAsync(failedIds),
    });
  const exportSelected = () => {
    const blob = new Blob([JSON.stringify(selectedList, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notifications-export-${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const toggleRow = (row: NotificationRow) =>
    setSelectedRows((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  const pageAllSelected = (data?.items.length ?? 0) > 0 && (data?.items.every((r) => selectedRows.has(r.id)) ?? false);
  const togglePage = () =>
    setSelectedRows((prev) => {
      const next = new Map(prev);
      if (pageAllSelected) data?.items.forEach((r) => next.delete(r.id));
      else data?.items.forEach((r) => next.set(r.id, r));
      return next;
    });

  const activeFilterCount = Object.values(filters).filter((v) => v !== undefined && v !== '').length;

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.notifications}>
      {/* Breadcrumb + page header (existing System header pattern) */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="flex items-center gap-1 text-xs text-gray-400">
            System <ChevronRight className="h-3 w-3" /> <span className="font-medium text-gray-600">Notification Center</span>
          </nav>
          <h2 className="mt-1 text-xl font-semibold text-gray-900">Notification Center</h2>
          <p className="mt-1 text-sm text-gray-500">Monitor every WhatsApp, Email, Push, and SMS notification sent by the platform.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400" title={query.dataUpdatedAt ? dt(new Date(query.dataUpdatedAt).toISOString()) : undefined}>
            Updated {updatedAgoLabel(query.dataUpdatedAt, nowTick)}
          </span>
          <Button onClick={() => void query.refetch()} disabled={query.isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {!ready || query.isLoading ? (
        <Skeleton />
      ) : query.isError || !data || !o ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load the notification center.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total" value={rp(o.summary.total)} />
            <Stat label="Sent" value={rp(o.summary.sent)} tone="ok" />
            <Stat label="Pending" value={rp(o.summary.pending)} tone={o.summary.pending > 0 ? 'warn' : undefined} />
            <Stat label="Sending" value={rp(o.summary.sending)} />
            <Stat label="Failed" value={rp(o.summary.failed)} tone={o.summary.failed > 0 ? 'error' : undefined} />
            <Stat label="Today's Success Rate" value={o.summary.todaySuccessRatePct != null ? `${o.summary.todaySuccessRatePct}%` : '—'} tone="ok" />
            <Stat label="Avg Delivery Time" value={deliveryLabel(o.summary.avgDeliverySec)} />
            <Stat label="Retried Today" value={rp(o.summary.retriedToday ?? 0)} tone={(o.summary.retriedToday ?? 0) > 0 ? 'warn' : undefined} />
          </div>

          {/* Charts */}
          <div className="grid gap-6 xl:grid-cols-3">
            <Card>
              <CardTitle>By Status</CardTitle>
              <div className="mt-4">
                <DonutChart segments={o.byStatus.filter((s) => s.count > 0).map((s) => ({ label: s.key, value: s.count, color: STATUS_COLORS[s.key] ?? '#94a3b8' }))} />
              </div>
            </Card>
            <Card>
              <CardTitle>By Channel</CardTitle>
              <div className="mt-4">
                <DonutChart segments={o.byChannel.filter((s) => s.count > 0).map((s) => ({ label: s.key, value: s.count, color: CHANNEL_COLORS[s.key] ?? '#94a3b8' }))} />
              </div>
            </Card>
            <Card>
              <CardTitle>Success Trend (7d)</CardTitle>
              {o.trend.length === 0 ? (
                <p className="py-10 text-center text-sm text-gray-500">No notifications yet.</p>
              ) : (
                <div className="mt-4"><TrendChart points={trendSeries(o.trend)} color="#22c55e" height={160} /></div>
              )}
            </Card>
          </div>

          <ByHourCard byHour={o.byHour ?? []} />

          {/* Recent failures */}
          {o.failures.length > 0 ? (
            <Card>
              <CardTitle>Recent Failures</CardTitle>
              <ul className="mt-3 space-y-2">
                {o.failures.map((f) => (
                  <li key={f.id} className="cursor-pointer rounded-lg border border-red-100 bg-red-50/50 p-2.5 text-sm" onClick={() => setSelectedId(f.id)}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-gray-800">{f.channel} · {f.template}</span>
                      <span className="text-xs text-gray-400">{dt(f.createdAt)} · {f.attempts} attempts</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-red-600" title={f.lastError ?? ''}>{f.lastError ?? '—'} · {f.recipient}</p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {/* Sticky filter bar (sits below the sticky topbar) + bulk action bar */}
          <div className="sticky top-16 z-10 -mx-1 space-y-2 px-1 pt-1">
            <Card className="shadow-sm">
              <div key={filterFormKey} className="flex flex-wrap items-end gap-3">
                <Filter label="Search"><input defaultValue={filters.search ?? ''} onChange={(e) => patchDebounced({ search: e.target.value || undefined })} placeholder="ID, recipient, phone, email, order no, payment, provider msg…" className="h-10 w-80 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white" /></Filter>
                <Filter label="Channel">
                  <select value={filters.channel ?? ''} onChange={(e) => patch({ channel: e.target.value as NotificationChannel | '' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                    <option value="">All</option>{CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Filter>
                <Filter label="Status">
                  <select value={filters.status ?? ''} onChange={(e) => patch({ status: e.target.value as NotificationSendStatus | '' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                    <option value="">All</option>{SEND_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </Filter>
                <Filter label="Provider">
                  <select value={filters.provider ?? ''} onChange={(e) => patch({ provider: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                    <option value="">All</option>{PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </Filter>
                <Filter label="Template"><input defaultValue={filters.template ?? ''} onChange={(e) => patchDebounced({ template: e.target.value || undefined })} placeholder="order.transfer" className="h-10 w-40 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="Recipient"><input defaultValue={filters.recipient ?? ''} onChange={(e) => patchDebounced({ recipient: e.target.value || undefined })} placeholder="628… / email" className="h-10 w-40 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="Order ID"><input defaultValue={filters.order ?? ''} onChange={(e) => patchDebounced({ order: e.target.value || undefined })} className="h-10 w-36 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="From"><input type="datetime-local" defaultValue={toLocalInput(filters.dateFrom)} onChange={(e) => patch({ dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="To"><input type="datetime-local" defaultValue={toLocalInput(filters.dateTo)} onChange={(e) => patch({ dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="Has Error">
                  <select value={filters.hasError ?? ''} onChange={(e) => patch({ hasError: (e.target.value || '') as '' | 'true' | 'false' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
                    <option value="">All</option><option value="true">With error</option><option value="false">Without error</option>
                  </select>
                </Filter>
                <Filter label="Min Retries"><input type="number" min={0} defaultValue={filters.retryMin ?? ''} onChange={(e) => patchDebounced({ retryMin: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} className="h-10 w-24 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="Duration ≥ (s)"><input type="number" min={0} defaultValue={filters.durationMin ?? ''} onChange={(e) => patchDebounced({ durationMin: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} className="h-10 w-24 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                <Filter label="Duration ≤ (s)"><input type="number" min={0} defaultValue={filters.durationMax ?? ''} onChange={(e) => patchDebounced({ durationMax: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} className="h-10 w-24 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
                {activeFilterCount > 0 ? (
                  <button onClick={resetFilters} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-gray-200 px-3 text-sm font-medium text-gray-600 hover:border-[#465fff] hover:text-[#465fff]">
                    <FilterX className="h-4 w-4" /> Reset ({activeFilterCount})
                  </button>
                ) : null}
              </div>
            </Card>

            {selectedRows.size > 0 ? (
              <Card className="shadow-sm">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-gray-800">{selectedRows.size} selected</span>
                  <span className="text-xs text-gray-400">({failedIds.length} failed / retryable)</span>
                  <PermissionGate permissions={ROUTE_PERMISSIONS.notificationResend}>
                    <Button
                      onClick={() => void bulkRetry()}
                      disabled={failedIds.length === 0 || failedIds.length > BULK_RETRY_LIMIT || bulkRetryM.isPending}
                      className="gap-2"
                      title={failedIds.length > BULK_RETRY_LIMIT ? `At most ${BULK_RETRY_LIMIT} per bulk retry` : undefined}
                    >
                      <RotateCcw className="h-4 w-4" /> Retry Selected ({failedIds.length})
                    </Button>
                  </PermissionGate>
                  <button onClick={exportSelected} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-gray-200 px-3 text-sm font-medium text-gray-600 hover:border-[#465fff] hover:text-[#465fff]">
                    <FileJson className="h-4 w-4" /> Export Selected JSON
                  </button>
                  <button onClick={() => setSelectedRows(new Map())} className="inline-flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-700">
                    <X className="h-3.5 w-3.5" /> Clear selection
                  </button>
                </div>
              </Card>
            ) : null}
          </div>

          {/* List */}
          <Card>
            <CardTitle>Notifications</CardTitle>
            <div className="mt-4 overflow-x-auto">
              {(data.items.length ?? 0) === 0 ? (
                <p className="p-10 text-center text-sm text-gray-500">No notifications found.</p>
              ) : (
                <table className="w-full min-w-[1100px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                      <th className="w-8 py-2">
                        <input type="checkbox" checked={pageAllSelected} onChange={togglePage} aria-label="Select all on this page" className="h-4 w-4 accent-[#465fff]" />
                      </th>
                      <th className="py-2 font-medium">Created</th><th className="py-2 font-medium">Channel</th><th className="py-2 font-medium">Status</th>
                      <th className="py-2 font-medium">Recipient</th><th className="py-2 font-medium">Template</th><th className="py-2 font-medium">Subject</th>
                      <th className="py-2 text-right font-medium">Attempts</th><th className="py-2 font-medium">Sent At</th><th className="py-2 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((n) => (
                      <tr key={n.id} onClick={() => setSelectedId(n.id)} className={`cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70 ${selectedRows.has(n.id) ? 'bg-indigo-50/40' : ''}`}>
                        <td className="py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={selectedRows.has(n.id)} onChange={() => toggleRow(n)} aria-label={`Select notification ${n.id}`} className="h-4 w-4 accent-[#465fff]" />
                        </td>
                        <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(n.createdAt)}</td>
                        <td className="py-2.5"><Badge cls={CHANNEL_BADGE[n.channel] ?? 'bg-gray-100 text-gray-600'}>{n.channel}</Badge></td>
                        <td className="py-2.5"><Badge cls={NOTIF_STATUS_BADGE[n.status]}>{n.status}</Badge></td>
                        <td className="py-2.5 text-gray-600">{n.recipient || '—'}</td>
                        <td className="py-2.5 text-gray-500">{n.template}</td>
                        <td className="max-w-[220px] truncate py-2.5 text-gray-700" title={n.subject ?? ''}>{n.subject ?? '—'}</td>
                        <td className="py-2.5 text-right text-gray-500">{n.attempts}</td>
                        <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(n.sentAt)}</td>
                        <td className="py-2.5 text-gray-500">{deliveryLabel(n.deliverySec)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {data.total > 0 ? (
              <Pagination page={data.page} limit={data.limit} total={data.total} totalPages={data.totalPages} onPageChange={setPage} onLimitChange={(l) => { setLimit(l); setPage(1); }} />
            ) : null}
          </Card>
        </div>
      )}

      {selectedId ? <NotificationDrawer id={selectedId} onClose={() => setSelectedId(null)} onResend={(id) => void resend(id)} /> : null}
    </AdminShell>
  );
}

function ByHourCard({ byHour }: { byHour: Array<{ hour: string; total: number; sent: number; failed: number }> }) {
  const hh = (iso: string) => new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return (
    <Card>
      <CardTitle>Notifications by Hour (last 24h)</CardTitle>
      {byHour.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">No hourly data yet.</p>
      ) : (
        <div className="mt-4">
          <BarChart values={byHour.map((h) => h.total)} color="#465fff" height={120} />
          <div className="mt-1 flex justify-between text-[11px] text-gray-400">
            <span>{hh(byHour[0].hour)}</span>
            <span>{hh(byHour[byHour.length - 1].hour)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Badge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs uppercase text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'error' }) {
  const color = tone === 'error' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : tone === 'ok' ? 'text-emerald-600' : 'text-gray-900';
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/3 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <Card className="h-72 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
    </div>
  );
}
