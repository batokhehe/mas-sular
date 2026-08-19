'use client';

import { ReactNode, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchSystemLogs, fetchSystemLog, LogLevel, SystemLog, SystemLogFilters } from '@/lib/admin';

const LEVELS: LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const LEVEL_CLASS: Record<LogLevel, string> = {
  INFO: 'bg-emerald-100 text-emerald-700',
  WARN: 'bg-amber-100 text-amber-700',
  ERROR: 'bg-red-100 text-red-700',
  DEBUG: 'bg-gray-100 text-gray-600',
};

const dt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' });

function LevelBadge({ level }: { level: LogLevel }) {
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${LEVEL_CLASS[level]}`}>{level}</span>;
}

export default function SystemLogsPage() {
  const [filters, setFilters] = useState<SystemLogFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const patch = (p: Partial<SystemLogFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['system-logs', filters, page, limit],
    queryFn: () => fetchSystemLogs({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const detail = useQuery({
    queryKey: ['system-log', selectedId],
    queryFn: () => fetchSystemLog(selectedId as string),
    enabled: !!selectedId,
    retry: false,
  });

  const data = query.data;

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.systemLogs}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">System Logs</h2>
        <p className="mt-1 text-sm text-gray-500">Structured request, exception, and worker events — newest first.</p>
      </div>

      <Card>
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Search</span>
            <input
              defaultValue={filters.search ?? ''}
              onChange={(e) => patch({ search: e.target.value })}
              placeholder="Message, Request ID, Order/Payment/User ID…"
              className="h-10 w-72 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Level</span>
            <select value={filters.level ?? ''} onChange={(e) => patch({ level: e.target.value as LogLevel | '' })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
              <option value="">All</option>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Module</span>
            <input defaultValue={filters.module ?? ''} onChange={(e) => patch({ module: e.target.value })} placeholder="http, exception…" className="h-10 w-40 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Status</span>
            <input defaultValue={filters.statusCode ?? ''} onChange={(e) => patch({ statusCode: e.target.value.replace(/\D/g, '') })} placeholder="500" className="h-10 w-24 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">From</span>
            <input type="datetime-local" onChange={(e) => patch({ dateFrom: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">To</span>
            <input type="datetime-local" onChange={(e) => patch({ dateTo: e.target.value ? new Date(e.target.value).toISOString() : undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
          </label>
        </div>

        <CardTitle className="mt-5">Logs</CardTitle>
        <div className="mt-4 overflow-x-auto">
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-10 w-full animate-pulse rounded bg-gray-100" />
              ))}
            </div>
          ) : query.isError ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <AlertTriangle className="h-6 w-6 text-red-500" />
              <p className="text-sm text-red-600">Unable to load logs.</p>
              <Button onClick={() => void query.refetch()}>Retry</Button>
            </div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="p-10 text-center text-sm text-gray-500">No logs found.</p>
          ) : (
            <table className="w-full min-w-[1000px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-2 font-medium">Time</th>
                  <th className="py-2 font-medium">Level</th>
                  <th className="py-2 font-medium">Module</th>
                  <th className="py-2 font-medium">Action</th>
                  <th className="py-2 font-medium">Message</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Duration</th>
                  <th className="py-2 font-medium">Request ID</th>
                  <th className="py-2 font-medium">User</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((log) => (
                  <tr key={log.id} onClick={() => setSelectedId(log.id)} className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                    <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(log.createdAt)}</td>
                    <td className="py-2.5"><LevelBadge level={log.level} /></td>
                    <td className="py-2.5 text-gray-700">{log.module}</td>
                    <td className="py-2.5 text-gray-500">{log.action}</td>
                    <td className="max-w-[280px] truncate py-2.5 text-gray-700" title={log.message}>{log.message}</td>
                    <td className="py-2.5 text-gray-500">{log.statusCode ?? '—'}</td>
                    <td className="py-2.5 text-gray-500">{log.durationMs != null ? `${log.durationMs}ms` : '—'}</td>
                    <td className="py-2.5 font-mono text-xs text-gray-400">{log.requestId ? `${log.requestId.slice(0, 8)}…` : '—'}</td>
                    <td className="py-2.5 text-gray-500">{log.adminId ?? log.userId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {data && data.total > 0 ? (
          <Pagination page={data.page} limit={data.limit} total={data.total} totalPages={data.totalPages} onPageChange={setPage} onLimitChange={(l) => { setLimit(l); setPage(1); }} />
        ) : null}
      </Card>

      {selectedId ? (
        <LogDrawer log={detail.data} loading={detail.isLoading} onClose={() => setSelectedId(null)} />
      ) : null}
    </AdminShell>
  );
}

function LogDrawer({ log, loading, onClose }: { log?: SystemLog; loading: boolean; onClose: () => void }) {
  const meta = (log?.metadata ?? {}) as Record<string, unknown>;
  const stack = typeof meta.stack === 'string' ? meta.stack : undefined;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h3 className="font-semibold text-gray-900">Log detail</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
          {loading || !log ? (
            <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-4 w-full animate-pulse rounded bg-gray-100" />)}</div>
          ) : (
            <>
              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">General</p>
                <dl className="space-y-1.5">
                  <Field label="Level" value={<LevelBadge level={log.level} />} />
                  <Field label="Time" value={dt(log.createdAt)} />
                  <Field label="Module" value={log.module} />
                  <Field label="Action" value={log.action} />
                  <Field label="Message" value={<span className="whitespace-pre-wrap break-words">{log.message}</span>} />
                  <Field label="Status" value={log.statusCode ?? '—'} />
                  <Field label="Duration" value={log.durationMs != null ? `${log.durationMs}ms` : '—'} />
                  <Field label="Method / Path" value={`${log.method ?? '—'} ${log.path ?? ''}`} />
                  <Field label="Request ID" value={<span className="font-mono text-xs">{log.requestId ?? '—'}</span>} />
                  <Field label="IP" value={log.ip ?? '—'} />
                  <Field label="Admin / User" value={log.adminId ?? log.userId ?? '—'} />
                  <Field label="Order / Payment / Shipment" value={[log.orderId, log.paymentId, log.shipmentId].filter(Boolean).join(' · ') || '—'} />
                </dl>
              </section>

              {stack ? (
                <section>
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Stack Trace</p>
                  <pre className="max-h-64 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-800">{stack}</pre>
                </section>
              ) : null}

              <section>
                <p className="mb-2 text-xs font-semibold uppercase text-gray-400">Metadata (payload / request / response)</p>
                <pre className="max-h-80 overflow-auto rounded-lg bg-gray-50 p-3 text-xs text-gray-700">{JSON.stringify(log.metadata ?? {}, null, 2)}</pre>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="shrink-0 text-gray-400">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}
