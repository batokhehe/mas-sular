'use client';

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendChart, BarChart, DonutChart } from '@/components/dashboard/charts';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchSystemDashboard } from '@/lib/admin';
import { formatNumberID } from '@/lib/utils/number';
import {
  summaryCards, successRate, failureRate, errorBars, WORKER_DOT, WORKER_LABEL, KpiTone,
} from '@/lib/system/dashboard-view';

const TONE_ICON: Record<KpiTone, string> = { default: 'bg-gray-100 text-gray-700', ok: 'bg-emerald-100 text-emerald-700', warn: 'bg-amber-100 text-amber-700', error: 'bg-red-100 text-red-700' };
const MODULE_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#a855f7', '#22c55e', '#64748b', '#ec4899'];
const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const rp = formatNumberID;

export default function SystemDashboardPage() {
  const [metric, setMetric] = useState<'requests' | 'response'>('requests');
  const query = useQuery({
    queryKey: ['system-dashboard'],
    queryFn: fetchSystemDashboard,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 60_000, // auto-refresh
    retry: false,
  });
  const d = query.data;

  const chartPoints = useMemo(() => {
    if (!d) return [];
    return d.requestMetrics.perHour.map((h) => ({ label: h.hour.slice(11), value: metric === 'requests' ? h.count : h.avgMs }));
  }, [d, metric]);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.systemLogs}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Dasbor Sistem</h2>
          <p className="mt-1 text-sm text-gray-500">Observabilitas langsung — request, error, antrean, worker, database, cache.</p>
        </div>
        <div className="flex items-center gap-3">
          {d ? <span className="text-xs text-gray-400">Diperbarui {new Date(d.generatedAt).toLocaleTimeString('id-ID')}</span> : null}
          <Button onClick={() => void query.refetch()} disabled={query.isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Muat ulang
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <DashboardSkeleton />
      ) : query.isError || !d ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Gagal memuat dasbor sistem.</p>
            <Button onClick={() => void query.refetch()}>Coba ulang</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {summaryCards(d).map((c) => (
              <Card key={c.key}>
                <div className={`mb-3 inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ${TONE_ICON[c.tone]}`}>{c.tone.toUpperCase()}</div>
                <p className="text-sm text-gray-500">{c.label}</p>
                <p className="mt-1 text-2xl font-semibold text-gray-900">{c.value}</p>
              </Card>
            ))}
          </div>

          {/* Requests + Errors */}
          <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <Card>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div><CardTitle>Requests (24h)</CardTitle><p className="mt-1 text-sm text-gray-500">p95 {rp(d.requestMetrics.p95Ms)}ms</p></div>
                <div className="flex rounded-lg bg-gray-100 p-1 text-xs">
                  {(['requests', 'response'] as const).map((m) => (
                    <button key={m} onClick={() => setMetric(m)} className={`rounded-md px-2.5 py-1 ${metric === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{m === 'requests' ? 'Requests/hr' : 'Response ms'}</button>
                  ))}
                </div>
              </div>
              {chartPoints.length === 0 ? <p className="py-10 text-center text-sm text-gray-500">Belum ada aktivitas request.</p> : <TrendChart points={chartPoints} color={metric === 'requests' ? '#465fff' : '#f59e0b'} />}
            </Card>
            <Card>
              <CardTitle>Errors (24h)</CardTitle>
              {d.errorMetrics.byHour.length === 0 ? (
                <p className="py-10 text-center text-sm text-gray-500">Tidak ada error.</p>
              ) : (
                <div className="mt-4"><BarChart values={errorBars(d.errorMetrics.byHour)} /></div>
              )}
              {d.errorMetrics.byModule.length > 0 ? (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <DonutChart segments={d.errorMetrics.byModule.slice(0, 6).map((m, i) => ({ label: m.key, value: m.count, color: MODULE_COLORS[i % MODULE_COLORS.length] }))} />
                </div>
              ) : null}
            </Card>
          </div>

          {/* Top endpoints + Recurring errors */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardTitle>Endpoint Teratas / Paling Lambat</CardTitle>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[420px] text-left text-sm">
                  <thead><tr className="border-b border-gray-100 text-xs uppercase text-gray-400"><th className="py-2 font-medium">Endpoint</th><th className="py-2 text-right font-medium">Jumlah</th><th className="py-2 text-right font-medium">Rata-rata</th><th className="py-2 text-right font-medium">Maks</th></tr></thead>
                  <tbody>
                    {d.requestMetrics.slowestEndpoints.length === 0 ? (
                      <tr><td colSpan={4} className="py-6 text-center text-sm text-gray-500">Tidak ada data.</td></tr>
                    ) : d.requestMetrics.slowestEndpoints.map((e) => (
                      <tr key={e.endpoint} className="border-b border-gray-50 last:border-0">
                        <td className="py-2 font-mono text-xs text-gray-700">{e.endpoint}</td>
                        <td className="py-2 text-right text-gray-500">{rp(e.count)}</td>
                        <td className="py-2 text-right font-medium text-gray-800">{rp(e.avgMs)}ms</td>
                        <td className="py-2 text-right text-gray-500">{rp(e.maxMs)}ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card>
              <CardTitle>Error Berulang Teratas</CardTitle>
              <div className="mt-4 space-y-2">
                {d.errorMetrics.topRecurring.length === 0 ? <p className="py-6 text-center text-sm text-gray-500">Tidak ada error berulang.</p> : d.errorMetrics.topRecurring.map((e, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm">
                    <span className="truncate pr-3 text-gray-700" title={e.message}>{e.message}</span>
                    <span className="shrink-0 rounded bg-red-100 px-2 py-0.5 font-semibold text-red-700">{rp(e.count)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Queue + Notifications */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardTitle>Antrean</CardTitle>
              <div className="mt-4 grid grid-cols-2 gap-4">
                {([['Outbox', d.queueMetrics.outbox], ['Notification', d.queueMetrics.notification]] as const).map(([name, q]) => (
                  <div key={name} className="rounded-xl border border-gray-100 p-3">
                    <p className="text-sm font-medium text-gray-800">{name}</p>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                      <Stat label="Menunggu" value={q.pending} tone={q.pending > 0 ? 'warn' : undefined} />
                      <Stat label="Diproses" value={q.processing} />
                      <Stat label="Gagal" value={q.failed} tone={q.failed > 0 ? 'error' : undefined} />
                      <Stat label="Coba ulang" value={q.retryCount} />
                    </div>
                    <p className="mt-2 text-xs text-gray-400">Tertunda paling lama: {dt(q.oldestPending)}</p>
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <CardTitle>Notifikasi</CardTitle>
              <div className="mt-4 grid grid-cols-2 gap-4">
                {([['WhatsApp', d.notificationMetrics.whatsapp], ['Email', d.notificationMetrics.email]] as const).map(([name, ch]) => (
                  <div key={name} className="rounded-xl border border-gray-100 p-3">
                    <p className="text-sm font-medium text-gray-800">{name}</p>
                    <p className="mt-1 text-2xl font-semibold text-emerald-600">{successRate(ch)}%<span className="ml-1 text-xs font-normal text-gray-400">berhasil</span></p>
                    <p className="text-xs text-red-500">{failureRate(ch)}% gagal</p>
                    <div className="mt-2 grid grid-cols-2 gap-1 text-xs text-gray-500">
                      <span>Terkirim: {rp(ch.success)}</span><span>Gagal: {rp(ch.failed)}</span>
                      <span>Coba ulang: {rp(ch.retry)}</span><span>Rata-rata: {rp(ch.avgSendSec)} dtk</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-400">Terakhir OK: {dt(ch.lastSuccess)}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          {/* Workers */}
          <Card>
            <CardTitle>Worker</CardTitle>
            <div className="mt-4 divide-y divide-gray-50">
              {d.workerMetrics.map((w) => (
                <div key={w.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2.5">
                    <span className={`h-2.5 w-2.5 rounded-full ${WORKER_DOT[w.status]}`} />
                    <span className="font-medium text-gray-800">{w.name}</span>
                    <span className="text-xs text-gray-400">{WORKER_LABEL[w.status]}</span>
                  </span>
                  <span className="flex items-center gap-4 text-xs text-gray-500">
                    <span>OK {rp(w.success)}</span>
                    <span className={w.failure > 0 ? 'text-red-500' : ''}>Gagal {rp(w.failure)}</span>
                    <span>Rata-rata {rp(w.avgMs)}ms</span>
                    <span>Terakhir {dt(w.lastExecution)}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* Database + Redis */}
          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <Card>
              <CardTitle>Database</CardTitle>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Pesanan hari ini" value={d.databaseMetrics.todayOrders} big />
                <Stat label="Pembayaran hari ini" value={d.databaseMetrics.todayPayments} big />
                <Stat label="Pengiriman hari ini" value={d.databaseMetrics.todayShipments} big />
                <Stat label="Total pesanan" value={d.databaseMetrics.totalOrders} big />
                <Stat label="Pelanggan" value={d.databaseMetrics.totalCustomers} big />
                <Stat label="Rata-rata checkout" value={`${rp(d.databaseMetrics.avgCheckoutMs)}ms`} big />
              </div>
            </Card>
            <Card>
              <CardTitle>Redis</CardTitle>
              <div className="mt-4 space-y-3 text-sm">
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
                  <span className="text-gray-600">Terhubung</span>
                  <span className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${d.cacheMetrics.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />{d.cacheMetrics.connected ? 'Ya' : 'Tidak'}</span>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5"><span className="text-gray-600">Latensi</span><span className="font-semibold text-gray-800">{rp(d.cacheMetrics.latencyMs)}ms</span></div>
                <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5"><span className="text-gray-600">Ping terakhir</span><span className="text-gray-500">{dt(d.cacheMetrics.lastPing)}</span></div>
                {d.cacheMetrics.memory ? <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5"><span className="text-gray-600">Memori</span><span className="text-gray-500">{d.cacheMetrics.memory}</span></div> : null}
              </div>
            </Card>
          </div>
        </div>
      )}
    </AdminShell>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: number | string; tone?: 'warn' | 'error'; big?: boolean }) {
  const color = tone === 'error' ? 'text-red-600' : tone === 'warn' ? 'text-amber-600' : 'text-gray-900';
  return (
    <div className={big ? 'rounded-xl border border-gray-100 p-3' : ''}>
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-0.5 ${big ? 'text-xl' : 'text-lg'} font-semibold ${color}`}>{typeof value === 'number' ? value.toLocaleString('id-ID') : value}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="mb-3 h-4 w-12 rounded bg-gray-100" /><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/2 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="h-64 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
        <Card className="h-64 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
      </div>
    </div>
  );
}
