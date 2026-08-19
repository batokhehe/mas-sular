'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Copy, SearchCode } from 'lucide-react';
import { AdminShell } from '@/components/layout/admin-shell';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { ROUTE_PERMISSIONS } from '@/lib/access';
import { fetchSystemRequests, RequestExplorerFilters } from '@/lib/admin';
import { statusTone } from '@/lib/system/request-explorer-view';

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
const STATUS_TONE: Record<ReturnType<typeof statusTone>, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  warn: 'bg-amber-100 text-amber-700',
  error: 'bg-red-100 text-red-700',
  muted: 'bg-gray-100 text-gray-500',
};

const dt = (iso: string) => new Date(iso).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'medium' });

export default function RequestExplorerPage() {
  const [filters, setFilters] = useState<RequestExplorerFilters>({});
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const patch = (p: Partial<RequestExplorerFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['system-requests', filters, page, limit],
    queryFn: () => fetchSystemRequests({ ...filters, page, limit }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = query.data;

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <AdminShell requiredPermissions={ROUTE_PERMISSIONS.systemLogs}>
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">Request Explorer</h2>
        <p className="mt-1 text-sm text-gray-500">Inspect the full lifecycle of any HTTP request via its request ID.</p>
      </div>

      <Card>
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Search</span>
            <input
              defaultValue={filters.search ?? ''}
              onChange={(e) => patch({ search: e.target.value })}
              placeholder="Request / Order / Payment / Shipment ID, customer…"
              className="h-10 w-80 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm outline-none focus:border-[#465fff] focus:bg-white"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Method</span>
            <select value={filters.method ?? ''} onChange={(e) => patch({ method: e.target.value || undefined })} className="h-10 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]">
              <option value="">All</option>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase text-gray-400">Status</span>
            <input defaultValue={filters.statusCode ?? ''} onChange={(e) => patch({ statusCode: e.target.value.replace(/\D/g, '') || undefined })} placeholder="500" className="h-10 w-24 rounded-xl border border-gray-200 bg-white px-3 text-sm outline-none focus:border-[#465fff]" />
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

        <CardTitle className="mt-5">Requests</CardTitle>
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
              <p className="text-sm text-red-600">Unable to load requests.</p>
              <Button onClick={() => void query.refetch()}>Retry</Button>
            </div>
          ) : (data?.items.length ?? 0) === 0 ? (
            <p className="p-10 text-center text-sm text-gray-500">No requests found.</p>
          ) : (
            <table className="w-full min-w-[1050px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs uppercase text-gray-400">
                  <th className="py-2 font-medium">Time</th>
                  <th className="py-2 font-medium">Method</th>
                  <th className="py-2 font-medium">Path</th>
                  <th className="py-2 font-medium">Status</th>
                  <th className="py-2 font-medium">Duration</th>
                  <th className="py-2 font-medium">User</th>
                  <th className="py-2 font-medium">Request ID</th>
                  <th className="py-2 text-right font-medium">Errors</th>
                  <th className="py-2 text-right font-medium">Warnings</th>
                  <th className="py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((r) => (
                  <tr key={`${r.requestId}-${r.finishedAt}`} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/70">
                    <td className="whitespace-nowrap py-2.5 text-gray-500">{dt(r.finishedAt)}</td>
                    <td className="py-2.5 font-mono text-xs font-semibold text-gray-700">{r.method ?? '—'}</td>
                    <td className="max-w-[260px] truncate py-2.5 text-gray-700" title={r.path ?? ''}>{r.path ?? '—'}</td>
                    <td className="py-2.5">
                      <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[statusTone(r.statusCode)]}`}>{r.statusCode ?? '—'}</span>
                    </td>
                    <td className="py-2.5 text-gray-500">{r.durationMs}ms</td>
                    <td className="py-2.5 text-gray-600">{r.admin?.name ?? r.user?.name ?? r.user?.email ?? '—'}</td>
                    <td className="py-2.5">
                      <span className="flex items-center gap-1.5 font-mono text-xs text-gray-400">
                        {r.requestId ? `${r.requestId.slice(0, 8)}…` : '—'}
                        {r.requestId ? (
                          <button onClick={() => copy(r.requestId!)} title="Copy Request ID" className="text-gray-300 hover:text-gray-600"><Copy className="h-3.5 w-3.5" /></button>
                        ) : null}
                      </span>
                    </td>
                    <td className={`py-2.5 text-right font-semibold ${r.errorCount > 0 ? 'text-red-600' : 'text-gray-400'}`}>{r.errorCount}</td>
                    <td className={`py-2.5 text-right font-semibold ${r.warningCount > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{r.warningCount}</td>
                    <td className="py-2.5">
                      {r.requestId ? (
                        <Link href={`/system/requests/${encodeURIComponent(r.requestId)}`} className="inline-flex items-center gap-1.5 text-xs font-medium text-[#465fff] hover:underline">
                          <SearchCode className="h-3.5 w-3.5" /> Inspect
                        </Link>
                      ) : null}
                    </td>
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
    </AdminShell>
  );
}
