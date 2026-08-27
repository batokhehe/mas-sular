'use client';

import { ReactNode, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, Copy, RefreshCw, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TrendChart, BarChart } from '@/components/dashboard/charts';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchSystemPerformance, PerfEndpoint, PerfRange } from '@/lib/admin';
import {
  PERF_RANGES, formatMs, sortEndpoints, filterEndpoints, latencyTone, EndpointSortKey, SortDir,
} from '@/lib/system/performance-view';

const TONE_TEXT: Record<ReturnType<typeof latencyTone>, string> = { ok: 'text-emerald-600', warn: 'text-amber-600', error: 'text-red-600' };
const dt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const rp = (n: number) => n.toLocaleString('id-ID');

export default function PerformancePage() {
  const [range, setRange] = useState<PerfRange>('24h');
  const [metric, setMetric] = useState<'latency' | 'requests' | 'slow'>('latency');
  const [sortKey, setSortKey] = useState<EndpointSortKey>('avgMs');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PerfEndpoint | null>(null);

  const query = useQuery({
    queryKey: ['system-performance', range],
    queryFn: () => fetchSystemPerformance(range),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    refetchInterval: 60_000, // auto refresh
    retry: false,
  });
  const d = query.data;

  const endpoints = useMemo(
    () => (d ? sortEndpoints(filterEndpoints(d.endpoints, search), sortKey, sortDir) : []),
    [d, search, sortKey, sortDir],
  );

  const chartPoints = useMemo(() => {
    if (!d) return [];
    return d.requests.perBucket.map((b) => ({
      label: b.bucket,
      value: metric === 'latency' ? b.avgMs : metric === 'requests' ? b.count : b.slowCount,
    }));
  }, [d, metric]);

  const toggleSort = (key: EndpointSortKey) => {
    if (sortKey === key) setSortDir((s) => (s === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.systemLogs}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Performance</h2>
          <p className="mt-1 text-sm text-gray-500">Latency, throughput, and slow paths across requests, workers, database, and cache.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg bg-gray-100 p-1 text-xs">
            {PERF_RANGES.map((r) => (
              <button key={r.key} onClick={() => setRange(r.key)} className={`rounded-md px-2.5 py-1 ${range === r.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>{r.label}</button>
            ))}
          </div>
          {d ? <span className="text-xs text-gray-400">Updated {new Date(d.generatedAt).toLocaleTimeString('id-ID')}</span> : null}
          <Button onClick={() => void query.refetch()} disabled={query.isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {query.isLoading ? (
        <Skeleton />
      ) : query.isError || !d ? (
        <Card>
          <div className="flex flex-col items-center gap-3 p-10 text-center">
            <AlertTriangle className="h-6 w-6 text-red-500" />
            <p className="text-sm text-red-600">Unable to load performance data.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Average Response Time" value={formatMs(d.summary.avgResponseMs)} toneClass={TONE_TEXT[latencyTone(d.summary.avgResponseMs)]} />
            <Stat label="P95" value={formatMs(d.summary.p95)} toneClass={TONE_TEXT[latencyTone(d.summary.p95)]} />
            <Stat label="P99" value={formatMs(d.summary.p99)} toneClass={TONE_TEXT[latencyTone(d.summary.p99)]} />
            <Stat label="Slow Requests (≥1s)" value={rp(d.summary.slowRequests)} toneClass={d.summary.slowRequests > 0 ? 'text-amber-600' : undefined} />
            <Stat label="Slow Workers (≥5s)" value={rp(d.summary.slowWorkers)} toneClass={d.summary.slowWorkers > 0 ? 'text-amber-600' : undefined} />
            <Stat label="Slow DB Calls (≥200ms)" value={rp(d.summary.slowDbCalls)} toneClass={d.summary.slowDbCalls > 0 ? 'text-amber-600' : undefined} />
            <Stat label="Cache Hit Rate" value={d.summary.cacheHitRate != null ? `${d.summary.cacheHitRate}%` : '—'} />
            <Stat label="Requests" value={rp(d.requests.count)} />
          </div>

          {/* Latency trend */}
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle>Latency Trend</CardTitle>
                <p className="mt-1 text-sm text-gray-500">p50 {formatMs(d.requests.p50)} · p95 {formatMs(d.requests.p95)} · p99 {formatMs(d.requests.p99)}</p>
              </div>
              <div className="flex rounded-lg bg-gray-100 p-1 text-xs">
                {(['latency', 'requests', 'slow'] as const).map((m) => (
                  <button key={m} onClick={() => setMetric(m)} className={`rounded-md px-2.5 py-1 capitalize ${metric === m ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
                    {m === 'latency' ? 'Avg latency' : m === 'requests' ? 'Requests' : 'Slow'}
                  </button>
                ))}
              </div>
            </div>
            {chartPoints.length === 0 ? (
              <p className="py-10 text-center text-sm text-gray-500">No request activity in this window.</p>
            ) : metric === 'latency' ? (
              <TrendChart points={chartPoints} color="#465fff" />
            ) : (
              <BarChart values={chartPoints.map((p) => p.value)} color={metric === 'slow' ? '#ef4444' : '#465fff'} />
            )}
          </Card>

          {/* Endpoint ranking */}
          <Card>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Endpoint Ranking (top 20 slowest)</CardTitle>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search endpoint…" className="h-10 w-64 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white" />
            </div>
            <div className="overflow-x-auto">
              {endpoints.length === 0 ? (
                <p className="p-8 text-center text-sm text-gray-500">No endpoints match.</p>
              ) : (
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                      <Th label="Endpoint" k="endpoint" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Avg" k="avgMs" right sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="P95" k="p95" right sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="P99" k="p99" right sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Max" k="maxMs" right sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <Th label="Requests" k="count" right sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <th className="py-2 font-medium">Copy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoints.map((e) => (
                      <tr key={e.endpoint} onClick={() => setSelected(e)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                        <td className="max-w-[340px] truncate py-2.5 font-mono text-xs text-gray-700" title={e.endpoint}>{e.endpoint}</td>
                        <td className={`py-2.5 text-right font-semibold ${TONE_TEXT[latencyTone(e.avgMs)]}`}>{formatMs(e.avgMs)}</td>
                        <td className="py-2.5 text-right text-gray-600">{formatMs(e.p95)}</td>
                        <td className="py-2.5 text-right text-gray-600">{formatMs(e.p99)}</td>
                        <td className="py-2.5 text-right text-gray-500">{formatMs(e.maxMs)}</td>
                        <td className="py-2.5 text-right text-gray-500">{rp(e.count)}</td>
                        <td className="py-2.5">
                          <button onClick={(ev) => { ev.stopPropagation(); copy(e.endpoint); }} title="Copy endpoint" className="text-gray-300 hover:text-gray-600"><Copy className="h-3.5 w-3.5" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          {/* Module ranking + Database */}
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardTitle>Module Ranking</CardTitle>
              <div className="mt-4 space-y-2">
                {d.modules.map((m) => {
                  const maxAvg = Math.max(1, ...d.modules.map((x) => x.avgMs));
                  return (
                    <div key={m.group} className="flex items-center gap-3 text-sm">
                      <span className="w-32 shrink-0 text-gray-600">{m.group}</span>
                      <div className="h-2.5 flex-1 rounded-full bg-gray-100">
                        <div className="h-2.5 rounded-full bg-[#465fff]" style={{ width: `${(m.avgMs / maxAvg) * 100}%` }} />
                      </div>
                      <span className={`w-16 text-right font-medium ${TONE_TEXT[latencyTone(m.avgMs)]}`}>{formatMs(m.avgMs)}</span>
                      <span className="w-16 text-right text-xs text-gray-400">{rp(m.count)}×</span>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card>
              <CardTitle>Database — Top Slow Queries</CardTitle>
              <p className="mt-1 text-xs text-gray-400">Aggregated in-process since {dt(d.database.since)} — query names only, no SQL.</p>
              <div className="mt-3 overflow-x-auto">
                {d.database.queries.length === 0 ? (
                  <p className="p-6 text-center text-sm text-gray-500">No query timings captured yet.</p>
                ) : (
                  <table className="w-full min-w-[420px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                        <th className="py-2 font-medium">Query</th><th className="py-2 text-right font-medium">Avg</th>
                        <th className="py-2 text-right font-medium">Max</th><th className="py-2 text-right font-medium">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.database.queries.map((q) => (
                        <tr key={q.name} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 font-mono text-xs text-gray-700">{q.name}</td>
                          <td className={`py-2 text-right font-medium ${q.avgMs >= 200 ? 'text-red-600' : 'text-gray-800'}`}>{formatMs(q.avgMs)}</td>
                          <td className="py-2 text-right text-gray-500">{formatMs(q.maxMs)}</td>
                          <td className="py-2 text-right text-gray-500">{rp(q.count)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>
          </div>

          {/* Workers + Cache */}
          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <Card>
              <CardTitle>Workers</CardTitle>
              <p className="mt-1 text-sm text-gray-500">Avg {formatMs(d.workers.avgMs)} · p95 {formatMs(d.workers.p95)} · p99 {formatMs(d.workers.p99)} · OK {rp(d.workers.success)} · Fail {rp(d.workers.failure)}</p>
              <div className="mt-3 overflow-x-auto">
                {d.workers.workers.length === 0 ? (
                  <p className="p-6 text-center text-sm text-gray-500">No worker executions in this window.</p>
                ) : (
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                        <th className="py-2 font-medium">Worker</th><th className="py-2 text-right font-medium">Avg</th>
                        <th className="py-2 text-right font-medium">P95</th><th className="py-2 text-right font-medium">P99</th>
                        <th className="py-2 text-right font-medium">Max</th><th className="py-2 text-right font-medium">OK</th><th className="py-2 text-right font-medium">Fail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.workers.workers.map((w) => (
                        <tr key={w.key} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 font-medium text-gray-800">{w.name}</td>
                          <td className="py-2 text-right text-gray-700">{formatMs(w.avgMs)}</td>
                          <td className="py-2 text-right text-gray-500">{formatMs(w.p95)}</td>
                          <td className="py-2 text-right text-gray-500">{formatMs(w.p99)}</td>
                          <td className="py-2 text-right text-gray-500">{formatMs(w.maxMs)}</td>
                          <td className="py-2 text-right text-gray-500">{rp(w.success)}</td>
                          <td className={`py-2 text-right ${w.failure > 0 ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{rp(w.failure)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Card>

            <Card>
              <CardTitle>Cache (Redis)</CardTitle>
              <div className="mt-4 space-y-3 text-sm">
                <CacheRow label="Connected"><span className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${d.cache.connected ? 'bg-emerald-500' : 'bg-red-500'}`} />{d.cache.connected ? 'Yes' : 'No'}</span></CacheRow>
                <CacheRow label="Latency"><span className="font-semibold text-gray-800">{formatMs(d.cache.latencyMs)}</span></CacheRow>
                <CacheRow label="Hits"><span className="text-gray-700">{d.cache.hits != null ? rp(d.cache.hits) : '—'}</span></CacheRow>
                <CacheRow label="Misses"><span className="text-gray-700">{d.cache.misses != null ? rp(d.cache.misses) : '—'}</span></CacheRow>
                <CacheRow label="Hit Rate"><span className="font-semibold text-emerald-600">{d.cache.hitRate != null ? `${d.cache.hitRate}%` : '—'}</span></CacheRow>
                <CacheRow label="Last Ping"><span className="text-gray-500">{dt(d.cache.lastPing)}</span></CacheRow>
              </div>
            </Card>
          </div>
        </div>
      )}

      {selected ? <EndpointDrawer endpoint={selected} onClose={() => setSelected(null)} /> : null}
    </AdminShell>
  );
}

function Th({ label, k, right, sortKey, sortDir, onSort }: {
  label: string; k: EndpointSortKey; right?: boolean; sortKey: EndpointSortKey; sortDir: SortDir; onSort: (k: EndpointSortKey) => void;
}) {
  const active = sortKey === k;
  const Icon = sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`py-2 font-medium ${right ? 'text-right' : ''}`}>
      <button onClick={() => onSort(k)} className={`inline-flex items-center gap-1 uppercase ${active ? 'text-gray-700' : ''}`}>
        {label} {active ? <Icon className="h-3 w-3" /> : null}
      </button>
    </th>
  );
}

function EndpointDrawer({ endpoint, onClose }: { endpoint: PerfEndpoint; onClose: () => void }) {
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="truncate pr-3 font-mono text-sm font-semibold text-gray-900" title={endpoint.endpoint}>{endpoint.endpoint}</h3>
          <span className="flex items-center gap-3">
            <button onClick={() => copy(endpoint.endpoint)} title="Copy endpoint" className="text-gray-400 hover:text-gray-700"><Copy className="h-4 w-4" /></button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
          </span>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <Mini label="Average" value={formatMs(endpoint.avgMs)} />
            <Mini label="P95" value={formatMs(endpoint.p95)} />
            <Mini label="P99" value={formatMs(endpoint.p99)} />
            <Mini label="Max" value={formatMs(endpoint.maxMs)} />
            <Mini label="Request Count" value={endpoint.count.toLocaleString('id-ID')} />
          </div>
          <section>
            <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Latest Requests</p>
            {endpoint.latest.length === 0 ? (
              <p className="text-sm text-gray-500">No recent samples.</p>
            ) : (
              <ul className="space-y-1.5">
                {endpoint.latest.map((r, i) => (
                  <li key={i} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2">
                    <span className="text-xs text-gray-500">{dt(r.time)}</span>
                    <span className="flex items-center gap-3">
                      <span className={`font-medium ${TONE_TEXT[latencyTone(r.durationMs)]}`}>{formatMs(r.durationMs)}</span>
                      <span className="text-xs text-gray-400">{r.statusCode ?? '—'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-100 p-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function CacheRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2.5">
      <span className="text-gray-600">{label}</span>
      {children}
    </div>
  );
}

function Stat({ label, value, toneClass }: { label: string; value: string; toneClass?: string }) {
  return (
    <Card>
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass ?? 'text-gray-900'}`}>{value}</p>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="animate-pulse"><div className="h-3 w-2/3 rounded bg-gray-200" /><div className="mt-2 h-6 w-1/2 rounded bg-gray-200" /></Card>
        ))}
      </div>
      <Card className="h-72 animate-pulse"><div className="h-full w-full rounded bg-gray-100" /></Card>
    </div>
  );
}
