'use client';

import { ReactNode, useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Download, RefreshCw, RotateCcw, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { PermissionGate } from '@/components/auth/permission-gate';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import {
  fetchQueueOverview, fetchQueueOutbox, fetchQueueNotifications,
  retryQueueOutbox, retryQueueNotification, retryAllFailedQueues,
  OutboxRow, QueueNotificationRow, OutboxFilters, QueueNotificationFilters, QueueWorker,
} from '@/lib/admin';
import {
  QUEUE_TABS, QueueTab, HEALTH_BADGE, HEALTH_LABEL, statusBadge, formatAge, relatedLinks, rowJson,
} from '@/lib/system/queue-center-view';
import { ADMIN_LOADING_MESSAGES, runWithFeedback } from '@/lib/admin-alert';

const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const rp = (n: number) => n.toLocaleString('id-ID');
type DrawerRow = { kind: 'outbox'; row: OutboxRow } | { kind: 'notification'; row: QueueNotificationRow };

export default function QueueCenterPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<QueueTab>('Outbox');
  const [drawer, setDrawer] = useState<DrawerRow | null>(null);

  const overview = useQuery({
    queryKey: ['queue-overview'],
    queryFn: fetchQueueOverview,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 15_000, // live auto-refresh
    retry: false,
  });
  const d = overview.data;

  const refreshAll = () => {
    void overview.refetch();
    qc.invalidateQueries({ queryKey: ['queue-outbox'] });
    qc.invalidateQueries({ queryKey: ['queue-notifications'] });
  };
  const retryAllM = useMutation({ mutationFn: retryAllFailedQueues, onSuccess: refreshAll });

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.queues}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Queue Center</h2>
          <p className="mt-1 text-sm text-gray-500">Outbox events, notifications, broker, and workers — live.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            <span className={`h-2 w-2 rounded-full ${overview.isFetching ? 'animate-pulse bg-emerald-500' : 'bg-emerald-400'}`} />
            Live · 15s
          </span>
          {d ? <span className="text-xs text-gray-400">Updated {new Date(d.generatedAt).toLocaleTimeString('id-ID')}</span> : null}
          <Button onClick={refreshAll} disabled={overview.isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${overview.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {overview.isLoading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Card key={i} className="animate-pulse"><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/2 rounded bg-gray-200" /></Card>
          ))}
        </div>
      ) : overview.isError || !d ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load the queue center.</p>
            <Button onClick={() => void overview.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Pending Events" value={rp(d.summary.pendingEvents)} tone={d.summary.pendingEvents > 0 ? 'warn' : undefined} />
            <Stat label="Processing" value={rp(d.summary.processing)} />
            <Stat label="Published" value={rp(d.summary.published)} />
            <Stat label="Failed" value={rp(d.summary.failed)} tone={d.summary.failed > 0 ? 'error' : undefined} />
            <Stat label="Retrying" value={rp(d.summary.retrying)} tone={d.summary.retrying > 0 ? 'warn' : undefined} />
            <Stat label="Dead Letters" value={rp(d.summary.deadLetters)} tone={d.summary.deadLetters > 0 ? 'error' : undefined} />
            <Stat label="Avg Publish Time" value={`${rp(d.summary.avgPublishMs)}ms`} />
            <Card>
              <p className="text-sm text-gray-500">Queue Health</p>
              <span className={`mt-2 inline-flex rounded-lg px-2.5 py-1 text-sm font-semibold ${HEALTH_BADGE[d.summary.health]}`}>{HEALTH_LABEL[d.summary.health]}</span>
            </Card>
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-1 rounded-xl bg-gray-100 p-1 text-sm">
            {QUEUE_TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-4 py-1.5 font-medium ${tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
                {t}
                {t === 'Failed' && d.summary.failed > 0 ? <span className="ml-1.5 rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700">{d.summary.failed}</span> : null}
              </button>
            ))}
          </div>

          {tab === 'Outbox' ? <OutboxTab onOpen={(row) => setDrawer({ kind: 'outbox', row })} /> : null}
          {tab === 'Notifications' ? <NotificationsTab onOpen={(row) => setDrawer({ kind: 'notification', row })} /> : null}
          {tab === 'RabbitMQ' ? <RabbitTab rabbit={d.rabbitmq} /> : null}
          {tab === 'Workers' ? <WorkersTab workers={d.workers} /> : null}
          {tab === 'Failed' ? (
            <FailedTab
              deadLetters={d.deadLetters}
              onRetryAll={(target) =>
                runWithFeedback({
                  loading: ADMIN_LOADING_MESSAGES.update,
                  success: 'Retry queued for all failed rows',
                  action: () => retryAllM.mutateAsync(target),
                })
              }
              retrying={retryAllM.isPending}
            />
          ) : null}
        </div>
      )}

      {drawer ? <QueueDrawer item={drawer} onClose={() => setDrawer(null)} onRetried={refreshAll} /> : null}
    </AdminShell>
  );
}

/* ---------------- Outbox tab ---------------- */

function OutboxTab({ onOpen }: { onOpen: (row: OutboxRow) => void }) {
  const [filters, setFilters] = useState<OutboxFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const patch = (p: Partial<OutboxFilters>) => { setFilters((f) => ({ ...f, ...p })); setPage(1); };

  const query = useQuery({
    queryKey: ['queue-outbox', filters, page, limit],
    queryFn: () => fetchQueueOutbox({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = query.data;

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Filter label="Search"><input defaultValue={filters.search ?? ''} onChange={(e) => patch({ search: e.target.value || undefined })} placeholder="ID, order number, payload…" className="h-10 w-72 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white" /></Filter>
        <Filter label="Status">
          <select value={filters.status ?? ''} onChange={(e) => patch({ status: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
            <option value="">All</option>{['PENDING', 'PUBLISHED', 'FAILED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Filter>
        <Filter label="Event"><input defaultValue={filters.event ?? ''} onChange={(e) => patch({ event: e.target.value || undefined })} placeholder="payment.paid" className="h-10 w-40 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
        <Filter label="Aggregate"><input defaultValue={filters.aggregate ?? ''} onChange={(e) => patch({ aggregate: e.target.value || undefined })} placeholder="order" className="h-10 w-32 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
        <Filter label="From"><input type="datetime-local" onChange={(e) => patch({ dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
        <Filter label="To"><input type="datetime-local" onChange={(e) => patch({ dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
      </div>

      <div className="mt-4 overflow-x-auto">
        <TableState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} empty={(data?.items.length ?? 0) === 0} emptyText="No outbox events found.">
          <table className="w-full min-w-[1050px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-2 font-medium">Created</th><th className="py-2 font-medium">Event</th><th className="py-2 font-medium">Aggregate</th>
                <th className="py-2 font-medium">Aggregate ID</th><th className="py-2 font-medium">Status</th><th className="py-2 text-right font-medium">Retries</th>
                <th className="py-2 font-medium">Published</th><th className="py-2 font-medium">Last Error</th><th className="py-2 font-medium">Refs</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                  <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(r.createdAt)}</td>
                  <td className="py-2.5 font-medium text-gray-800">{r.eventName}</td>
                  <td className="py-2.5 text-gray-500">{r.aggregateType}</td>
                  <td className="py-2.5 font-mono text-xs text-gray-400">{r.aggregateId.slice(0, 8)}…</td>
                  <td className="py-2.5"><span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${statusBadge(r.status)}`}>{r.status}</span></td>
                  <td className="py-2.5 text-right text-gray-500">{r.attempts}/{r.maxAttempts}</td>
                  <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(r.publishedAt)}</td>
                  <td className="max-w-[180px] truncate py-2.5 text-red-500" title={r.lastError ?? ''}>{r.lastError ?? '—'}</td>
                  <td className="py-2.5 text-xs text-gray-400">{relatedLinks(r.related).map((l) => l.label).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableState>
      </div>
      {data && data.total > 0 ? <Pagination page={data.page} limit={data.limit} total={data.total} totalPages={data.totalPages} onPageChange={setPage} onLimitChange={(l) => { setLimit(l); setPage(1); }} /> : null}
    </Card>
  );
}

/* ---------------- Notifications tab ---------------- */

function NotificationsTab({ onOpen }: { onOpen: (row: QueueNotificationRow) => void }) {
  const [filters, setFilters] = useState<QueueNotificationFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const patch = (p: Partial<QueueNotificationFilters>) => { setFilters((f) => ({ ...f, ...p })); setPage(1); };

  const query = useQuery({
    queryKey: ['queue-notifications', filters, page, limit],
    queryFn: () => fetchQueueNotifications({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = query.data;

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <Filter label="Search"><input defaultValue={filters.search ?? ''} onChange={(e) => patch({ search: e.target.value || undefined })} placeholder="Recipient, phone, email, order…" className="h-10 w-72 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white" /></Filter>
        <Filter label="Channel">
          <select value={filters.channel ?? ''} onChange={(e) => patch({ channel: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
            <option value="">All</option>{['WHATSAPP', 'EMAIL'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Filter>
        <Filter label="Status">
          <select value={filters.status ?? ''} onChange={(e) => patch({ status: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
            <option value="">All</option>{['PENDING', 'SENT', 'FAILED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Filter>
        <Filter label="Template"><input defaultValue={filters.template ?? ''} onChange={(e) => patch({ template: e.target.value || undefined })} placeholder="order.transfer" className="h-10 w-44 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" /></Filter>
      </div>

      <div className="mt-4 overflow-x-auto">
        <TableState loading={query.isLoading} error={query.isError} retry={() => void query.refetch()} empty={(data?.items.length ?? 0) === 0} emptyText="No notifications found.">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                <th className="py-2 font-medium">Created</th><th className="py-2 font-medium">Channel</th><th className="py-2 font-medium">Template</th>
                <th className="py-2 font-medium">Recipient</th><th className="py-2 font-medium">Status</th><th className="py-2 text-right font-medium">Retries</th>
                <th className="py-2 font-medium">Sent</th><th className="py-2 font-medium">Last Error</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <tr key={r.id} onClick={() => onOpen(r)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                  <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(r.createdAt)}</td>
                  <td className="py-2.5 font-medium text-gray-800">{r.channel}</td>
                  <td className="py-2.5 text-gray-500">{r.template}</td>
                  <td className="py-2.5 text-gray-600">{r.recipient || '—'}</td>
                  <td className="py-2.5"><span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${statusBadge(r.status)}`}>{r.status}</span></td>
                  <td className="py-2.5 text-right text-gray-500">{r.attempts}</td>
                  <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(r.sentAt)}</td>
                  <td className="max-w-[200px] truncate py-2.5 text-red-500" title={r.lastError ?? ''}>{r.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableState>
      </div>
      {data && data.total > 0 ? <Pagination page={data.page} limit={data.limit} total={data.total} totalPages={data.totalPages} onPageChange={setPage} onLimitChange={(l) => { setLimit(l); setPage(1); }} /> : null}
    </Card>
  );
}

/* ---------------- RabbitMQ / Workers / Failed tabs ---------------- */

function RabbitTab({ rabbit }: { rabbit: { configured: boolean; connected: boolean; latencyMs: number | null; lastPing: string; metricsAvailable: boolean } }) {
  return (
    <Card>
      <CardTitle>RabbitMQ</CardTitle>
      {!rabbit.configured ? (
        <p className="mt-4 text-sm text-gray-500">RabbitMQ is not configured (RABBITMQ_URL unset).</p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-100 p-3">
            <p className="text-xs text-gray-400">Connected</p>
            <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-gray-900">
              <span className={`h-2.5 w-2.5 rounded-full ${rabbit.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              {rabbit.connected ? 'Healthy' : 'Unreachable'}
            </p>
          </div>
          <div className="rounded-xl border border-gray-100 p-3"><p className="text-xs text-gray-400">Ping Latency</p><p className="mt-1 text-lg font-semibold text-gray-900">{rabbit.latencyMs != null ? `${rabbit.latencyMs}ms` : '—'}</p></div>
          <div className="rounded-xl border border-gray-100 p-3"><p className="text-xs text-gray-400">Last Ping</p><p className="mt-1 text-lg font-semibold text-gray-900">{dt(rabbit.lastPing)}</p></div>
        </div>
      )}
      {rabbit.configured && !rabbit.metricsAvailable ? (
        <p className="mt-3 text-xs text-gray-400">Per-queue metrics (ready/unacked/consumers/rates/memory) require the RabbitMQ management API, which is not integrated.</p>
      ) : null}
    </Card>
  );
}

function WorkersTab({ workers }: { workers: QueueWorker[] }) {
  return (
    <Card>
      <CardTitle>Workers</CardTitle>
      <div className="mt-4 divide-y divide-gray-50">
        {workers.map((w) => (
          <div key={w.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <span className="flex items-center gap-2.5">
              <span className={`h-2.5 w-2.5 rounded-full ${!w.enabled ? 'bg-gray-300' : w.running ? 'bg-emerald-500' : 'bg-amber-400'}`} />
              <span className="font-medium text-gray-800">{w.name}</span>
              <span className="text-xs text-gray-400">{!w.enabled ? 'Disabled' : w.running ? 'Running' : 'Idle'}</span>
            </span>
            <span className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
              <span>Heartbeat {dt(w.heartbeat)}</span>
              <span>Last OK {dt(w.lastSuccess)}</span>
              <span className={w.lastFailure ? 'text-red-500' : ''}>Last fail {dt(w.lastFailure)}</span>
              <span>Avg {rp(w.avgMs)}ms</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function FailedTab({ deadLetters, onRetryAll, retrying }: {
  deadLetters: {
    outboxCount: number; notificationCount: number;
    outbox: Array<{ id: string; eventName: string; attempts: number; lastError: string | null; ageMs: number }>;
    notifications: Array<{ id: string; channel: string; template: string; recipient: string; attempts: number; lastError: string | null; ageMs: number }>;
  };
  onRetryAll: (target: 'outbox' | 'notifications' | 'all') => void;
  retrying: boolean;
}) {
  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Failed Events</CardTitle>
          <PermissionGate permissions={ROUTE_PERMISSIONS.queueRetry}>
            <Button onClick={() => onRetryAll('all')} disabled={retrying} className="gap-2"><RotateCcw className="h-4 w-4" /> Retry All Failed</Button>
          </PermissionGate>
        </div>
        <div className="mt-4 grid gap-5 xl:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Failed Outbox ({deadLetters.outboxCount})</p>
            {deadLetters.outbox.length === 0 ? <p className="text-sm text-gray-500">No failed outbox events.</p> : (
              <ul className="space-y-2">
                {deadLetters.outbox.map((r) => (
                  <li key={r.id} className="rounded-lg border border-red-100 bg-red-50/50 p-2.5 text-sm">
                    <div className="flex items-center justify-between"><span className="font-medium text-gray-800">{r.eventName}</span><span className="text-xs text-gray-400">{formatAge(r.ageMs)} old · {r.attempts} retries</span></div>
                    <p className="mt-0.5 truncate text-xs text-red-600" title={r.lastError ?? ''}>{r.lastError ?? '—'}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Failed Notifications ({deadLetters.notificationCount})</p>
            {deadLetters.notifications.length === 0 ? <p className="text-sm text-gray-500">No failed notifications.</p> : (
              <ul className="space-y-2">
                {deadLetters.notifications.map((r) => (
                  <li key={r.id} className="rounded-lg border border-red-100 bg-red-50/50 p-2.5 text-sm">
                    <div className="flex items-center justify-between"><span className="font-medium text-gray-800">{r.channel} · {r.template}</span><span className="text-xs text-gray-400">{formatAge(r.ageMs)} old · {r.attempts} retries</span></div>
                    <p className="mt-0.5 truncate text-xs text-red-600" title={r.lastError ?? ''}>{r.lastError ?? '—'} · {r.recipient}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Detail drawer ---------------- */

function QueueDrawer({ item, onClose, onRetried }: { item: DrawerRow; onClose: () => void; onRetried: () => void }) {
  const row = item.row;
  const json = rowJson(row);
  const links = relatedLinks(row.related);
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.kind}-${row.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const retryM = useMutation({
    mutationFn: () => (item.kind === 'outbox' ? retryQueueOutbox(row.id) : retryQueueNotification(row.id)),
    onSuccess: () => { onRetried(); onClose(); },
  });

  const general: Array<[string, ReactNode]> = item.kind === 'outbox'
    ? [
        ['Event', (row as OutboxRow).eventName], ['Aggregate', `${(row as OutboxRow).aggregateType} · ${(row as OutboxRow).aggregateId}`],
        ['Exchange / Key', `${(row as OutboxRow).exchange} / ${(row as OutboxRow).routingKey}`],
        ['Status', row.status], ['Retries', `${row.attempts}/${(row as OutboxRow).maxAttempts}`],
        ['Created', dt(row.createdAt)], ['Published', dt((row as OutboxRow).publishedAt)], ['Next attempt', dt(row.nextAttemptAt)],
      ]
    : [
        ['Channel', (row as QueueNotificationRow).channel], ['Template', (row as QueueNotificationRow).template],
        ['Recipient', (row as QueueNotificationRow).recipient || '—'], ['Status', row.status], ['Retries', String(row.attempts)],
        ['Created', dt(row.createdAt)], ['Sent', dt((row as QueueNotificationRow).sentAt)],
        ['Provider msg', (row as QueueNotificationRow).providerMessageId ?? '—'], ['Source msg', (row as QueueNotificationRow).sourceMessageId ?? '—'],
      ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">{item.kind === 'outbox' ? 'Outbox event' : 'Notification'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          {row.status === 'FAILED' ? (
            <PermissionGate permissions={ROUTE_PERMISSIONS.queueRetry}>
              <Button onClick={() => retryM.mutate()} disabled={retryM.isPending} className="w-full gap-2">
                <RotateCcw className="h-4 w-4" /> {retryM.isPending ? 'Retrying…' : 'Retry (reset to PENDING)'}
              </Button>
            </PermissionGate>
          ) : null}

          <section>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">General</p>
            <dl className="space-y-1.5">
              {general.map(([label, value]) => (
                <div key={label} className="flex items-start justify-between gap-4">
                  <dt className="shrink-0 text-gray-400">{label}</dt>
                  <dd className="text-right font-medium text-gray-800">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          {links.length > 0 ? (
            <section>
              <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Related</p>
              <div className="flex flex-wrap gap-2">
                {links.map((l) => (
                  <Link key={l.label} href={l.href} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:border-[#465fff] hover:text-[#465fff]">
                    {l.label} <span className="font-mono text-gray-400">{l.id.length > 12 ? `${l.id.slice(0, 8)}…` : l.id}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {row.lastError ? (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase text-gray-400">Last Error</p>
                <button onClick={() => copy(row.lastError ?? '')} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy</button>
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-red-50 p-3 text-xs text-red-800">{row.lastError}</pre>
            </section>
          ) : null}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase text-gray-400">Payload JSON</p>
              <span className="flex gap-3">
                <button onClick={() => copy(json)} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Copy className="h-3.5 w-3.5" /> Copy JSON</button>
                <button onClick={download} className="inline-flex items-center gap-1 text-xs font-medium text-[#465fff]"><Download className="h-3.5 w-3.5" /> Download JSON</button>
              </span>
            </div>
            <pre className="max-h-72 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(row.payload ?? {}, null, 2)}</pre>
          </section>

          {item.kind === 'outbox' && (row as OutboxRow).metadata ? (
            <section>
              <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Metadata</p>
              <pre className="max-h-48 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify((row as OutboxRow).metadata, null, 2)}</pre>
            </section>
          ) : null}
        </div>
      </aside>
    </>
  );
}

/* ---------------- shared bits ---------------- */

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'error' }) {
  const color = tone === 'error' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900';
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${color}`}>{value}</p>
    </Card>
  );
}

function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="block text-xs uppercase text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function TableState({ loading, error, retry, empty, emptyText, children }: {
  loading: boolean; error: boolean; retry: () => void; empty: boolean; emptyText: string; children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 w-full animate-pulse rounded bg-gray-100" />)}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center">
        <AlertTriangle className="h-6 w-6 text-red-500" />
        <p className="text-sm text-red-600">Unable to load.</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  }
  if (empty) return <p className="p-10 text-center text-sm text-gray-500">{emptyText}</p>;
  return <>{children}</>;
}
